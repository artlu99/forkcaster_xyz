// Offline client-rank generator — queries CLICK_STATS (Analytics Engine,
// sample-weighted), assembles the rank snapshot, publishes one lmdis key.
//
// Run: dotenvx run -- bun scripts/client-rank.ts [--dry]
// Env: see .env.example (same vars as race-stats).
//
// Overwrite-only-on-success: the lmdis key is written last, after every
// query and aggregation succeeded — a failed run leaves the previous
// snapshot serving.

import { LmdisClient } from "../worker/vendor/lmdis-sdk.ts";
import {
	AE_MISSING_ENV_MESSAGE,
	aeCredentials,
	aeSql,
	statsWindowHours,
	wantsDry,
} from "./ae-sql.ts";
import {
	aggregateRank,
	buildRankQuery,
	buildRankTotalsQuery,
	type RankSnapshot,
} from "./client-rank-lib.ts";

const { accountId, apiToken } = aeCredentials();
const sql = (query: string) => aeSql({ accountId, apiToken }, query);
const LMDIS_URL = process.env.LMDIS_URL ?? "";
const LMDIS_TOKEN = process.env.LMDIS_REST_TOKEN ?? "";
const WINDOW_HOURS = statsWindowHours();
const KEY = process.env.RANK_KEY ?? "client-rank";
const DRY = wantsDry();

// --- aggregate + main ---

async function aggregate(hours: number): Promise<RankSnapshot> {
	const [rows, totalsRows] = await Promise.all([
		sql(buildRankQuery(hours)),
		sql(buildRankTotalsQuery(hours)),
	]);
	return aggregateRank(
		rows as unknown as Parameters<typeof aggregateRank>[0],
		(totalsRows[0] ?? {}) as { total: unknown; maxSampleInterval: unknown },
		hours,
		new Date().toISOString(),
	);
}

if (
	accountId === "" ||
	apiToken === "" ||
	LMDIS_URL === "" ||
	LMDIS_TOKEN === ""
) {
	console.error(AE_MISSING_ENV_MESSAGE);
	process.exit(1);
}

console.log(`aggregating CLICK_STATS over the last ${WINDOW_HOURS}h…`);
const snapshot = await aggregate(WINDOW_HOURS);
console.log(JSON.stringify(snapshot, null, "\t"));

if (DRY) {
	console.log("--dry: not publishing");
	process.exit(0);
}

const lmdis = new LmdisClient({ url: LMDIS_URL, token: LMDIS_TOKEN });
await lmdis.set(KEY, JSON.stringify(snapshot));
const stored = await lmdis.get<RankSnapshot>(KEY);
console.log(
	`published ${KEY} → lmdis; readback v=${stored?.v} generatedAt=${stored?.generatedAt}`,
);
