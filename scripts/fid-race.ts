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
	buildFidLegsQuery,
	buildFidTalliesQuery,
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

/** One grouped tallies row → the source's stats block. */
function sourceStats(row: Record<string, unknown> | undefined): FidSourceStats {
	const wins = num(row?.wins);
	return {
		wins,
		p50Ms: wins > 0 ? Math.round(num(row?.p50)) : null,
		p95Ms: wins > 0 ? Math.round(num(row?.p95)) : null,
	};
}

async function aggregate(hours: number): Promise<FidSnapshot> {
	const [tallyRows, legRows] = await Promise.all([
		sql(buildFidTalliesQuery(hours)),
		sql(buildFidLegsQuery(hours)),
	]);
	// Open vocabulary: every observed index1 id gets a row — cloud-era
	// "shim", fleet members ("shim-potato", -2, …), and the raw gateways.
	// Key-sorted so the published snapshot is byte-stable across runs.
	const sources: Record<string, FidSourceStats> = {};
	for (const row of tallyRows ?? []) {
		const source = String(row?.source ?? "");
		if (source !== "") sources[source] = sourceStats(row);
	}
	const legs: Record<string, number> = {};
	for (const row of legRows ?? []) {
		const leg = String(row?.leg ?? "");
		if (leg !== "") legs[leg] = num(row?.settled);
	}
	const sortKeys = (record: Record<string, unknown>) =>
		Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));

	return {
		v: 2,
		generatedAt: new Date().toISOString(),
		window: { hours },
		sampled:
			(tallyRows ?? []).reduce(
				(max, row) => Math.max(max, num(row?.maxSampleInterval)),
				0,
			) > 1,
		sources: sortKeys(sources) as Record<string, FidSourceStats>,
		legs: sortKeys(legs) as Record<string, number>,
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
