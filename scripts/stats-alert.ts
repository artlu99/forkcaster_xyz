// Offline stats alerter — reads the three published lmdis snapshots and
// pushes to ntfy.sh when thresholds breach. Unlike the stats scripts (which
// write after computing), this checks what VISITORS currently see, so it
// runs on its own cadence and doubles as a dead-man's-switch for the whole
// pipeline: a stale or missing snapshot is itself an alert.
//
// Run: dotenvx run -- bun scripts/stats-alert.ts [--dry]
// Env: see .env.example (LMDIS_URL, LMDIS_REST_TOKEN; NTFY_URL — the topic
// URL, whose path acts as the credential, so use an unguessable topic;
// optional NTFY_TOKEN for access-controlled topics; thresholds
// ALERT_P95_MS, ALERT_ERROR_RATE, ALERT_STALE_HOURS; NTFY_ON_OK=1 to also
// push an all-clear).
//
// Exit 0 = the check ran (issues, if any, were pushed); 1 = couldn't run
// or deliver. Breaches are communicated via ntfy, never the exit code.

import { LmdisClient } from "../worker/vendor/lmdis-sdk.ts";
import { wantsDry } from "./ae-sql.ts";
import { validateRankSnapshot } from "../worker/client-rank-store.ts";
import { validateFidSnapshot } from "../worker/fid-race-store.ts";
import { validateSnapshot } from "../worker/race-stats-store.ts";

const LMDIS_URL = (process.env.LMDIS_URL ?? "").replace(/\/+$/, "");
const LMDIS_TOKEN = process.env.LMDIS_REST_TOKEN ?? "";
const NTFY_URL = (process.env.NTFY_URL ?? "").replace(/\/+$/, "");
const NTFY_TOKEN = process.env.NTFY_TOKEN ?? "";
const P95_MAX = Number(process.env.ALERT_P95_MS ?? 2000);
const ERR_MAX = Number(process.env.ALERT_ERROR_RATE ?? 0.05);
const STALE_HOURS = Number(process.env.ALERT_STALE_HOURS ?? 48);
const ON_OK = process.env.NTFY_ON_OK === "1";
const DRY = wantsDry();

type Outcome<T> =
	| { kind: "ok"; value: T; generatedAt: string | null }
	| { kind: "bad"; reason: string };

async function getKey<T extends { generatedAt?: string }>(
	key: string,
	validate: (raw: unknown) => T | null,
): Promise<Outcome<T>> {
	if (LMDIS_URL === "" || LMDIS_TOKEN === "") {
		return { kind: "bad", reason: "lmdis env missing" };
	}
	try {
		const client = new LmdisClient({
			url: LMDIS_URL,
			token: LMDIS_TOKEN,
			fetch: (input, init) =>
				fetch(input, { ...init, signal: AbortSignal.timeout(5000) }),
		});
		const raw = await client.get<unknown>(key);
		if (raw === null) return { kind: "bad", reason: "missing key" };
		const value = validate(raw);
		if (value === null) return { kind: "bad", reason: "unknown shape" };
		return { kind: "ok", value, generatedAt: value.generatedAt ?? null };
	} catch (error) {
		return {
			kind: "bad",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

async function push(
	title: string,
	message: string,
	priority: number,
	tags: string[],
): Promise<void> {
	if (NTFY_URL === "") {
		throw new Error("NTFY_URL missing — set the topic URL in .env");
	}
	const url = new URL(NTFY_URL);
	const topic = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
	if (topic === "" || topic.includes("/")) {
		throw new Error("NTFY_URL must point at one topic (https://ntfy.sh/<topic>)");
	}
	const res = await fetch(`${url.origin}/`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(NTFY_TOKEN === "" ? {} : { authorization: `Bearer ${NTFY_TOKEN}` }),
		},
		body: JSON.stringify({ topic, title, message, priority, tags }),
		signal: AbortSignal.timeout(5000),
	});
	if (!res.ok) throw new Error(`ntfy returned ${res.status}`);
}

const [race, rank, fid] = await Promise.all([
	getKey("race-stats", validateSnapshot),
	getKey("client-rank", validateRankSnapshot),
	getKey("fid-race", validateFidSnapshot),
]);

const problems: string[] = [];

// Provider breaches — the latency/error contract visitors actually experience.
if (race.kind === "ok") {
	for (const p of race.value.providers) {
		if (p.requests <= 0) continue;
		const why: string[] = [];
		if (p.p95Ms !== null && p.p95Ms > P95_MAX) {
			why.push(`p95 ${p.p95Ms}ms > ${P95_MAX}ms`);
		}
		if (p.errorRate > ERR_MAX) {
			why.push(`err ${(p.errorRate * 100).toFixed(2)}% > ${(ERR_MAX * 100).toFixed(1)}%`);
		}
		if (why.length > 0) problems.push(`${p.id}: ${why.join(", ")}`);
	}
}

// Staleness — the pipeline's dead-man's-switch. A snapshot older than the
// threshold (or unparseable) means stats stopped being refreshed.
for (const [name, outcome] of [
	["race-stats", race],
	["client-rank", rank],
	["fid-race", fid],
] as const) {
	if (outcome.kind !== "ok") continue;
	const generatedAt = outcome.generatedAt;
	const ageHours = generatedAt === null ? NaN : (Date.now() - Date.parse(generatedAt)) / 3_600_000;
	if (!Number.isFinite(ageHours)) {
		problems.push(`${name}: unparseable generatedAt`);
	} else if (ageHours > STALE_HOURS) {
		problems.push(
			`${name}: stale — generatedAt ${generatedAt} (${Math.round(ageHours)}h old > ${STALE_HOURS}h)`,
		);
	}
}

// Unreachable / missing / unknown-shape — urgent, lmdis itself is the story.
for (const [name, outcome] of [
	["race-stats", race],
	["client-rank", rank],
	["fid-race", fid],
] as const) {
	if (outcome.kind === "bad") problems.push(`${name}: unreadable (${outcome.reason})`);
}

if (problems.length === 0) {
	console.log(
		`all clear: no provider breaches (p95 ≤ ${P95_MAX}ms, err ≤ ${(ERR_MAX * 100).toFixed(1)}%), snapshots fresh (≤ ${STALE_HOURS}h), lmdis reachable`,
	);
	if (!ON_OK || DRY) process.exit(0);
	try {
		await push("forkcaster stats: all clear", "All snapshots fresh, no breaches.", 2, [
			"white_check_mark",
		]);
	} catch (error) {
		console.error(`ntfy push failed: ${error instanceof Error ? error.message : error}`);
		process.exit(1);
	}
	process.exit(0);
}

const title = `forkcaster stats: ${problems.length} issue${problems.length === 1 ? "" : "s"}`;
const message = `${problems.join("\n")}\n\nchecked ${new Date().toISOString()}`;
const priority = [race, rank, fid].some((o) => o.kind === "bad") ? 5 : 4;

if (DRY) {
	console.log(`[dry] would push (priority ${priority}): ${title}\n${message}`);
	process.exit(0);
}

try {
	await push(title, message, priority, ["rotating_light"]);
	console.log(`pushed: ${title}`);
} catch (error) {
	console.error(`ntfy push failed: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
}
console.log(problems.map((p) => `- ${p}`).join("\n"));
