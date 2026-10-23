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
	aggregateRank,
	buildRankQuery,
	buildRankTotalsQuery,
	type RankSnapshot,
} from "./client-rank-lib.ts";

// ANALYTICS_* names are wrangler-inert on purpose (see race-stats.ts).
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
const KEY = process.env.RANK_KEY ?? "client-rank";
const DRY = process.argv.includes("--dry");

// --- AE SQL layer (same shapes as race-stats.ts) ---

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
