// Offline race-stats generator — queries Analytics Engine (sample-weighted),
// assembles the transparency snapshot, publishes one lmdis key.
//
// Run: dotenvx run -- bun scripts/race-stats.ts [--dry]
// Env: see .env.example (ANALYTICS_ACCOUNT_ID, ANALYTICS_API_TOKEN,
// LMDIS_URL, LMDIS_REST_TOKEN; optional STATS_WINDOW_HOURS, STATS_KEY).
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
import { aggregateRaceStats } from "./race-stats-aggregate.ts";
import type { Snapshot } from "./race-stats-lib.ts";

const { accountId, apiToken } = aeCredentials();
const sql = (query: string) => aeSql({ accountId, apiToken }, query);
const LMDIS_URL = process.env.LMDIS_URL ?? "";
const LMDIS_TOKEN = process.env.LMDIS_REST_TOKEN ?? "";
const WINDOW_HOURS = statsWindowHours();
const KEY = process.env.STATS_KEY ?? "race-stats";
const DRY = wantsDry();

if (
	accountId === "" ||
	apiToken === "" ||
	LMDIS_URL === "" ||
	LMDIS_TOKEN === ""
) {
	console.error(AE_MISSING_ENV_MESSAGE);
	process.exit(1);
}

console.log(`aggregating RACE_STATS over the last ${WINDOW_HOURS}h…`);
const snapshot = await aggregateRaceStats(sql, WINDOW_HOURS);
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
