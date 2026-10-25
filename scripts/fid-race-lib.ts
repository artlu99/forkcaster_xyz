// Fid-race query builders — pure functions, no env, no I/O (mirrors
// race-stats-lib.ts; the same AE dialect constraints apply: no CONCAT,
// only toUInt32/toUInt8, position(needle IN haystack), quantileExactWeighted
// with _sample_interval weights).
//
// The FID_RACE dataset gets one row per raw-node leg whose identity race
// settled (worker/cast-source.ts resolveFid): index1 = the WINNING source
// ("shim" or the leg's own id "haatz"/"snap"), blob1 = leg id, blob2 =
// host, double1 = the winner's ms. Nodes are tracked independently — a
// node's win is attributed to that node, never merged into a bucket.

import { buildWindow } from "./race-stats-lib.ts";

export type FidSource = "shim" | "haatz" | "snap";

export const FID_SOURCES: readonly FidSource[] = ["shim", "haatz", "snap"];

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
	const cols = FID_SOURCES.map(
		(source) => `sumIf(_sample_interval, index1 = '${source}') AS ${source}_wins`,
	);
	cols.push(
		"sumIf(_sample_interval, position('haatz' IN blob1) > 0) AS leg_haatz",
		"sumIf(_sample_interval, position('snap' IN blob1) > 0) AS leg_snap",
		"max(_sample_interval) AS maxSampleInterval",
	);
	return `SELECT ${cols.join(", ")}
	FROM FID_RACE WHERE ${buildWindow(hours)}`;
}

/** Weighted p50/p95 (+ sample count) for one source's winning latencies. */
export function buildFidLatencyQuery(source: FidSource, hours: number): string {
	return `SELECT quantileExactWeighted(0.5)(double1, _sample_interval) AS p50,
	quantileExactWeighted(0.95)(double1, _sample_interval) AS p95,
	sum(_sample_interval) AS samples
	FROM FID_RACE WHERE ${buildWindow(hours)} AND index1 = '${source}'`;
}
