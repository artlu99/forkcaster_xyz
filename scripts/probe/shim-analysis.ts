// Phase 0 follow-up — what does the telemetry say about shim's slowness?
// Discriminates "slow on first touch (cache miss), fast on repeat (hit)"
// from "shim is just slow/broken":
//   Q1  shim latency when it WON the race (real settle, uncut by the box)
//   Q2  per-ms histogram of shim's winning settles
//   Q3  shim latency when it lost (expect ~700 = the abort cut)
//   Q4  hourly trend: races / shim wins / shim settled-found (warming trend?)
//   Q5  anatomy of the not-found race (shim's miss-404 latency)
// Run: dotenvx run -- bun scripts/probe/shim-analysis.ts

import { buildWindow, msExpr } from "../race-stats-lib.ts";

const account =
	process.env.ANALYTICS_ACCOUNT_ID ??
	process.env.CLOUDFLARE_ACCOUNT_ID ??
	process.env.CF_ACCOUNT_ID ??
	"";
const token =
	process.env.ANALYTICS_API_TOKEN ??
	process.env.CLOUDFLARE_API_TOKEN ??
	process.env.CF_API_TOKEN ?? "";
if (account === "" || token === "") {
	console.error(
		"missing CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN — load via dotenvx",
	);
	process.exit(1);
}

async function sql(query: string): Promise<Record<string, unknown>[]> {
	const r = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`,
		{
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			body: query,
			signal: AbortSignal.timeout(20000),
		},
	);
	const text = await r.text();
	if (r.status !== 200)
		throw new Error(`AE SQL ${r.status}: ${text.slice(0, 300)}`);
	const parsed: unknown = JSON.parse(text);
	const data = (parsed as { data?: unknown }).data;
	return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

const w = buildWindow(168);

// Q1 — shim's real settle time in races it won vs races it lost
for (const [label, winnerFilter] of [
	["shim WON the race", "index1 = 'shim'"],
	["shim LOST the race", "index1 != 'shim'"],
] as const) {
	const rows = await sql(`SELECT
		quantileExactWeighted(0.5)(${msExpr("shim")}, _sample_interval) AS p50,
		quantileExactWeighted(0.95)(${msExpr("shim")}, _sample_interval) AS p95,
		min(${msExpr("shim")}) AS minMs,
		max(${msExpr("shim")}) AS maxMs,
		sum(_sample_interval) AS n
	FROM RACE_STATS WHERE ${w} AND ${winnerFilter}`);
	console.log(`Q1 ${label}:`, JSON.stringify(rows[0]));
}

// Q2 — histogram of shim's winning settles (cache-hit fast path?)
{
	const rows =
		await sql(`SELECT ${msExpr("shim")} AS ms, sum(_sample_interval) AS n
	FROM RACE_STATS WHERE ${w} AND index1 = 'shim'
	GROUP BY ms ORDER BY ms ASC`);
	console.log("Q2 shim winning-settle histogram:", JSON.stringify(rows));
}

// Q3 — hourly trend: are wins getting more common as the cache warms?
{
	const rows = await sql(`SELECT
		intDiv(toUInt32(timestamp), 3600) * 3600 AS hour,
		sum(_sample_interval) AS races,
		sumIf(_sample_interval, index1 = 'shim') AS shimWins,
		sumIf(_sample_interval, index1 = 'farcaster-tv') AS ftvWins
	FROM RACE_STATS WHERE ${w}
	GROUP BY hour ORDER BY hour ASC`);
	console.log("Q3 hourly:", JSON.stringify(rows));
}

// Q4 — anatomy of the not-found race
{
	const rows = await sql(
		`SELECT blob1, index1 FROM RACE_STATS WHERE index1 = 'not-found' AND ${w}`,
	);
	console.log("Q4 not-found anatomy:", JSON.stringify(rows));
}
