// Fid-race query builders — pure functions, no env, no I/O (mirrors
// race-stats-lib.ts; the same AE dialect constraints apply: no CONCAT,
// only toUInt32/toUInt8, position(needle IN haystack), quantileExactWeighted
// with _sample_interval weights).
//
// The FID_RACE dataset gets one row per raw-node leg whose identity race
// settled (worker/cast-source.ts resolveFid): index1 = winning source
// ("shim" | "node"), blob1 = leg id ("haatz" | "snap"), blob2 = host,
// double1 = the winner's ms.

import { buildWindow } from "./race-stats-lib.ts";

export type FidSource = "shim" | "node";

export type FidSourceStats = {
	wins: number;
	p50Ms: number | null;
	p95Ms: number | null;
};

/** The transparency snapshot contract for the "Author id races" item. */
export type FidSnapshot = {
	v: 1;
	generatedAt: string;
	window: { hours: number };
	sampled: boolean;
	sources: Record<FidSource, FidSourceStats>;
	/** Settled races per raw-node leg (blob1). */
	legs: { haatz: number; snap: number };
};

/** Weighted wins per source, per-leg coverage, and the sampling ceiling. */
export function buildFidTalliesQuery(hours: number): string {
	return `SELECT sumIf(_sample_interval, index1 = 'shim') AS shim_wins,
	sumIf(_sample_interval, index1 = 'node') AS node_wins,
	sumIf(_sample_interval, position('haatz' IN blob1) > 0) AS leg_haatz,
	sumIf(_sample_interval, position('snap' IN blob1) > 0) AS leg_snap,
	max(_sample_interval) AS maxSampleInterval
	FROM FID_RACE WHERE ${buildWindow(hours)}`;
}

/** Weighted p50/p95 (+ sample count) for one source's winning latencies. */
export function buildFidLatencyQuery(source: FidSource, hours: number): string {
	return `SELECT quantileExactWeighted(0.5)(double1, _sample_interval) AS p50,
	quantileExactWeighted(0.95)(double1, _sample_interval) AS p95,
	sum(_sample_interval) AS samples
	FROM FID_RACE WHERE ${buildWindow(hours)} AND index1 = '${source}'`;
}
