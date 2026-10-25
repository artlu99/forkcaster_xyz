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
	AE_MISSING_ENV_MESSAGE,
	aeCredentials,
	aeSql,
	num,
	statsWindowHours,
	wantsDry,
} from "./ae-sql.ts";
import {
	buildFidLatencyQuery,
	buildFidTalliesQuery,
	FID_SOURCES,
	type FidSnapshot,
	type FidSourceStats,
} from "./fid-race-lib.ts";

const { accountId, apiToken } = aeCredentials();
const sql = (query: string) => aeSql({ accountId, apiToken }, query);
const LMDIS_URL = process.env.LMDIS_URL ?? "";
const LMDIS_TOKEN = process.env.LMDIS_REST_TOKEN ?? "";
const WINDOW_HOURS = statsWindowHours();
const KEY = process.env.FID_STATS_KEY ?? "fid-race";
const DRY = wantsDry();

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
	accountId === "" ||
	apiToken === "" ||
	LMDIS_URL === "" ||
	LMDIS_TOKEN === ""
) {
	console.error(AE_MISSING_ENV_MESSAGE);
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
