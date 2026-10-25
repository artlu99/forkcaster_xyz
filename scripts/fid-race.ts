// Offline fid-race stats generator — the parallel item to race-stats.ts:
// queries the FID_RACE Analytics Engine dataset (sample-weighted),
// assembles the "Author id races" snapshot, publishes one lmdis key.
//
// Run: dotenvx run -- bun scripts/fid-race.ts [--dry]
// Env: see .env.example (same ANALYTICS_* / LMDIS_* discipline as
// scripts/race-stats.ts).
//
// Overwrite-only-on-success: the lmdis key is written last, after every
// query and aggregation succeeded — a failed run leaves the previous
// snapshot serving.

import { LmdisClient } from "../worker/vendor/lmdis-sdk.ts";
import {
	buildFidLatencyQuery,
	buildFidTalliesQuery,
	FID_SOURCES,
	type FidSnapshot,
	type FidSourceStats,
} from "./fid-race-lib.ts";

// Same env names as race-stats.ts — ANALYTICS_* are wrangler-inert on
// purpose (see the comment there).
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
const KEY = process.env.FID_STATS_KEY ?? "fid-race";
const DRY = process.argv.includes("--dry");

// --- AE SQL layer (mirrors scripts/race-stats.ts) ---

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

const emptyStats = (): FidSourceStats => ({
	wins: 0,
	p50Ms: null,
	p95Ms: null,
});

async function aggregate(hours: number): Promise<FidSnapshot> {
	const [tallyRow] = await sql(buildFidTalliesQuery(hours));
	const maxSampleInterval = num(tallyRow?.maxSampleInterval);

	const sources = await Promise.all(
		FID_SOURCES.map(async (source) => {
			const [latencyRow] = await sql(buildFidLatencyQuery(source, hours));
			const wins = num(tallyRow?.[`${source}_wins`]);
			const samples = num(latencyRow?.samples);
			const stats: FidSourceStats = {
				wins,
				p50Ms: samples > 0 ? Math.round(num(latencyRow?.p50)) : null,
				p95Ms: samples > 0 ? Math.round(num(latencyRow?.p95)) : null,
			};
			return [source, stats] as const;
		}),
	);
	const bySource = new Map(sources);

	return {
		v: 1,
		generatedAt: new Date().toISOString(),
		window: { hours },
		sampled: maxSampleInterval > 1,
		sources: {
			shim: bySource.get("shim") ?? emptyStats(),
			haatz: bySource.get("haatz") ?? emptyStats(),
			snap: bySource.get("snap") ?? emptyStats(),
		},
		legs: {
			haatz: num(tallyRow?.leg_haatz),
			snap: num(tallyRow?.leg_snap),
		},
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

console.log(`aggregating FID_RACE over the last ${WINDOW_HOURS}h…`);
const snapshot = await aggregate(WINDOW_HOURS);
console.log(JSON.stringify(snapshot, null, "\t"));

if (DRY) {
	console.log("--dry: not publishing");
	process.exit(0);
}

const lmdis = new LmdisClient({ url: LMDIS_URL, token: LMDIS_TOKEN });
await lmdis.set(KEY, JSON.stringify(snapshot));
const stored = await lmdis.get<FidSnapshot>(KEY);
console.log(
	`published ${KEY} → lmdis; readback v=${stored?.v} generatedAt=${stored?.generatedAt}`,
);
