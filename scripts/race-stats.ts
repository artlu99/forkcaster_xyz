// Offline race-stats generator — queries Analytics Engine (sample-weighted),
// assembles the transparency snapshot, publishes one lmdis key.
//
// Run: dotenvx run -- bun scripts/race-stats.ts [--dry]
// Env: see .env.example (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN,
// LMDIS_URL, LMDIS_REST_TOKEN; optional STATS_WINDOW_HOURS, STATS_KEY).
//
// Overwrite-only-on-success: the lmdis key is written last, after every
// query and aggregation succeeded — a failed run leaves the previous
// snapshot serving.

import { LmdisClient } from "../worker/vendor/lmdis-sdk.ts";
import {
	buildLatencyQuery,
	buildOutcomesQuery,
	buildTalliesQuery,
	ROSTER,
	type Snapshot,
} from "./race-stats-lib.ts";

// ANALYTICS_* names are wrangler-inert on purpose: bun auto-loads .env into
// every `bun run` process, and CLOUDFLARE_* names collide with wrangler's
// own auth env (ciphertext values even broke `bun run deploy`).
const ACCOUNT_ID =
	process.env.ANALYTICS_ACCOUNT_ID ??
	process.env.CLOUDFLARE_ACCOUNT_ID ??
	process.env.CF_ACCOUNT_ID ??
	"";
const API_TOKEN =
	process.env.ANALYTICS_API_TOKEN ??
	process.env.CLOUDFLARE_API_TOKEN ??
	process.env.CF_API_TOKEN ??
	"";
const LMDIS_URL = process.env.LMDIS_URL ?? "";
const LMDIS_TOKEN = process.env.LMDIS_REST_TOKEN ?? "";
const WINDOW_HOURS = Number(process.env.STATS_WINDOW_HOURS ?? "168") || 168;
const KEY = process.env.STATS_KEY ?? "race-stats";
const DRY = process.argv.includes("--dry");

// --- AE SQL layer ---

const SQL_ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`;

type Row = Record<string, unknown>;

async function sql(query: string): Promise<Row[]> {
	const res = await fetch(SQL_ENDPOINT, {
		method: "POST",
		headers: { authorization: `Bearer ${API_TOKEN}` },
		body: query,
		signal: AbortSignal.timeout(20000),
	});
	const text = await res.text();
	if (res.status !== 200) {
		// SQL errors are plain text (422); auth errors are the v4 JSON envelope.
		let detail = text.slice(0, 300);
		try {
			const parsed = JSON.parse(text) as {
				errors?: Array<{ message?: string }>;
			};
			detail = parsed.errors?.map((e) => e.message).join("; ") ?? detail;
		} catch {
			// plain text already in detail
		}
		throw new Error(`AE SQL ${res.status}: ${detail}`);
	}
	const parsed: unknown = JSON.parse(text);
	const data = (parsed as { data?: unknown }).data;
	if (!Array.isArray(data)) {
		throw new Error(`AE SQL: unexpected response shape: ${text.slice(0, 200)}`);
	}
	return data as Row[];
}

const num = (value: unknown): number => {
	const n = Number(value ?? 0);
	return Number.isFinite(n) ? n : 0;
};

// --- aggregate ---

async function aggregate(hours: number): Promise<Snapshot> {
	const [outcomeRows, tallyRows] = await Promise.all([
		sql(buildOutcomesQuery(hours)),
		sql(buildTalliesQuery(hours)),
	]);

	const outcomes = new Map<string, number>();
	for (const row of outcomeRows) outcomes.set(String(row.outcome), num(row.n));
	const wins = (id: string): number => outcomes.get(id) ?? 0;

	const tallies = tallyRows[0] ?? {};
	const raced = (id: string, kind: string): number =>
		num(tallies[`${id.replace(/-/g, "_")}_${kind}`]);
	const maxSampleInterval = num(tallies.maxSampleInterval);

	const providers = await Promise.all(
		ROSTER.map(async (p) => {
			const [latencyRow] = await sql(buildLatencyQuery(p.id, hours));
			const requests =
				raced(p.id, "found") +
				raced(p.id, "miss") +
				raced(p.id, "error") +
				raced(p.id, "abort");
			const errors = raced(p.id, "error");
			const samples = num(latencyRow?.samples);
			return {
				id: p.id,
				role: p.role,
				wins: wins(p.id),
				requests,
				p50Ms: samples > 0 ? Math.round(num(latencyRow?.p50)) : null,
				p95Ms: samples > 0 ? Math.round(num(latencyRow?.p95)) : null,
				errorRate:
					requests > 0 ? Math.round((errors / requests) * 10000) / 10000 : 0,
			};
		}),
	);

	const found = providers.reduce((sum, p) => sum + p.wins, 0);
	return {
		v: 1,
		generatedAt: new Date().toISOString(),
		window: { hours },
		sampled: maxSampleInterval > 1,
		outcomes: {
			found,
			notFound: wins("not-found"),
			unreachable: wins("unreachable"),
		},
		providers,
	};
}

// --- main ---

if (
	ACCOUNT_ID === "" ||
	API_TOKEN === "" ||
	LMDIS_URL === "" ||
	LMDIS_TOKEN === ""
) {
	console.error(
		"missing env — need CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, LMDIS_URL, LMDIS_REST_TOKEN (see .env.example; run via dotenvx)",
	);
	process.exit(1);
}

console.log(`aggregating RACE_STATS over the last ${WINDOW_HOURS}h…`);
const snapshot = await aggregate(WINDOW_HOURS);
console.log(JSON.stringify(snapshot, null, "\t"));

if (DRY) {
	console.log("--dry: not publishing");
	process.exit(0);
}

const lmdis = new LmdisClient({ url: LMDIS_URL, token: LMDIS_TOKEN });
await lmdis.set(KEY, JSON.stringify(snapshot));
const stored = await lmdis.get<Snapshot>(KEY);
console.log(
	`published ${KEY} → lmdis; readback v=${stored?.v} generatedAt=${stored?.generatedAt}`,
);
