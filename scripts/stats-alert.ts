// Offline stats alerter. Provider p95 and errorRate come from Analytics
// Engine over the last ALERT_WINDOW_HOURS (default 6) — a separate window
// from the 168h snapshot /transparency publishes. The published lmdis
// snapshots are still read, as the pipeline's dead-man's-switch: a stale
// or missing snapshot is itself an alert. Host uptime, disk, load, and
// memory belong to Netdata, not this script.
//
// Run: dotenvx run -- bun scripts/stats-alert.ts [--dry]
// Env: see .env.example (ANALYTICS_ACCOUNT_ID, ANALYTICS_API_TOKEN,
// LMDIS_URL, LMDIS_REST_TOKEN; NTFY_URL — the topic URL, whose path acts
// as the credential, so use an unguessable topic; optional NTFY_TOKEN for
// access-controlled topics; thresholds ALERT_P95_MS, ALERT_ERROR_RATE,
// ALERT_WINDOW_HOURS, ALERT_STALE_HOURS; NTFY_ON_OK=1 to also push an
// all-clear).
//
// Exit 0 = the check ran (issues, if any, were pushed); 1 = couldn't run
// or deliver. Breaches are communicated via ntfy, never the exit code.

import { validateRankSnapshot } from "../worker/client-rank-store.ts";
import { validateFidSnapshot } from "../worker/fid-race-store.ts";
import { validateSnapshot } from "../worker/race-stats-store.ts";
import { LmdisClient } from "../worker/vendor/lmdis-sdk.ts";
import { aeCredentials, aeSql, wantsDry } from "./ae-sql.ts";
import { aggregateRaceStats } from "./race-stats-aggregate.ts";
import type { Snapshot } from "./race-stats-lib.ts";
import { providerBreaches, snapshotProblems } from "./stats-alert-lib.ts";

const LMDIS_URL = (process.env.LMDIS_URL ?? "").replace(/\/+$/, "");
const LMDIS_TOKEN = process.env.LMDIS_REST_TOKEN ?? "";
const NTFY_URL = (process.env.NTFY_URL ?? "").replace(/\/+$/, "");
const NTFY_TOKEN = process.env.NTFY_TOKEN ?? "";
const P95_MAX = Number(process.env.ALERT_P95_MS ?? 2000);
const ERR_MAX = Number(process.env.ALERT_ERROR_RATE ?? 0.05);
const ALERT_WINDOW_HOURS = Number(process.env.ALERT_WINDOW_HOURS ?? "6") || 6;
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

async function recentRaceStats(): Promise<
	{ kind: "ok"; value: Snapshot } | { kind: "bad"; reason: string }
> {
	const creds = aeCredentials();
	if (creds.accountId === "" || creds.apiToken === "") {
		return { kind: "bad", reason: "analytics env missing" };
	}
	try {
		return {
			kind: "ok",
			value: await aggregateRaceStats(
				(query) => aeSql(creds, query),
				ALERT_WINDOW_HOURS,
			),
		};
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
		throw new Error(
			"NTFY_URL must point at one topic (https://ntfy.sh/<topic>)",
		);
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

const [recent, race, rank, fid] = await Promise.all([
	recentRaceStats(),
	getKey("race-stats", validateSnapshot),
	getKey("client-rank", validateRankSnapshot),
	getKey("fid-race", validateFidSnapshot),
]);

const breaches =
	recent.kind === "ok"
		? providerBreaches(recent.value.providers, {
				p95Max: P95_MAX,
				errMax: ERR_MAX,
			})
		: [];
const problems: string[] = [];

if (recent.kind === "bad") {
	problems.push(
		`race-stats ${ALERT_WINDOW_HOURS}h: unreadable (${recent.reason})`,
	);
}

// Published snapshots are the pipeline's dead-man's-switch, not the
// latency source. Missing, unreadable, or older than the threshold.
problems.push(
	...snapshotProblems(
		[
			["race-stats", race],
			["client-rank", rank],
			["fid-race", fid],
		],
		Date.now(),
		STALE_HOURS,
	),
);

const issueCount = breaches.length + problems.length;

if (issueCount === 0) {
	console.log(
		`all clear: no provider breaches in the last ${ALERT_WINDOW_HOURS}h (p95 ≤ ${P95_MAX}ms, err ≤ ${(ERR_MAX * 100).toFixed(1)}%), snapshots fresh (≤ ${STALE_HOURS}h), lmdis reachable`,
	);
	if (!ON_OK || DRY) process.exit(0);
	try {
		await push(
			"forkcaster stats: all clear",
			`No provider breaches in the last ${ALERT_WINDOW_HOURS}h. Snapshots fresh.`,
			2,
			["white_check_mark"],
		);
	} catch (error) {
		console.error(
			`ntfy push failed: ${error instanceof Error ? error.message : error}`,
		);
		process.exit(1);
	}
	process.exit(0);
}

const sections: string[] = [];
if (breaches.length > 0)
	sections.push([`last ${ALERT_WINDOW_HOURS}h`, ...breaches].join("\n"));
if (problems.length > 0) sections.push(problems.join("\n"));
const title = `forkcaster stats: ${issueCount} issue${issueCount === 1 ? "" : "s"} (${ALERT_WINDOW_HOURS}h)`;
const message = `${sections.join("\n\n")}\n\nchecked ${new Date().toISOString()}`;
const priority =
	recent.kind === "bad" || [race, rank, fid].some((o) => o.kind === "bad")
		? 5
		: 4;

if (DRY) {
	console.log(`[dry] would push (priority ${priority}): ${title}\n${message}`);
	process.exit(0);
}

try {
	await push(title, message, priority, ["rotating_light"]);
	console.log(`pushed: ${title}\n${message}`);
} catch (error) {
	console.error(
		`ntfy push failed: ${error instanceof Error ? error.message : error}`,
	);
	process.exit(1);
}
