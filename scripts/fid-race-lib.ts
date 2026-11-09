// Fid-race query builders — pure functions, no env, no I/O (mirrors
// race-stats-lib.ts; the same AE dialect constraints apply: no CONCAT,
// only toUInt32/toUInt8, position(needle IN haystack), quantileExactWeighted
// with _sample_interval weights).
//
// The FID_RACE dataset gets one row per raw-node leg whose identity race
// settled (worker/cast-source.ts resolveFid): index1 = the WINNING source
// id, blob1 = leg id, blob2 = host, double1 = the winner's ms. The index1
// vocabulary is OPEN (v2, cloud-retirement cutover): the leg's own gateway
// reports its id ("haatz"/"snap"); the shim side reports the fleet member
// that named the fid — its hostname label (fleetSeatId): "shim" (the
// self-hosted reader at shim.artlu.xyz, fleet lead since the Nov 9 2026
// cutover — the id also carries cloud's pre-cutover points until they
// decay ~Nov 12) or the host's own name, "shim-potato" / "shim-potato-2"
// / … (the same id the cast race records). Rows are grouped by index1 at
// aggregation time, so fleet members join the snapshot as they appear —
// no source list is hardcoded anywhere.

import { buildWindow } from "./race-stats-lib.ts";

export type FidSourceStats = {
	wins: number;
	p50Ms: number | null;
	p95Ms: number | null;
};

/** The transparency snapshot contract for the "Author id races" item.
 * v2: `sources`/`legs` are open records keyed by the raw dataset ids. */
export type FidSnapshot = {
	v: 2;
	generatedAt: string;
	window: { hours: number };
	sampled: boolean;
	/** Weighted wins + winning latencies per source (index1), open-ended. */
	sources: Record<string, FidSourceStats>;
	/** Settled races per raw-node leg (blob1), open-ended. */
	legs: Record<string, number>;
};

/** Wins, weighted p50/p95, and the sampling ceiling per source — one
 * grouped pass (the old per-source sumIf/latency pair, collapsed; the
 * source set is whatever the window observed). */
export function buildFidTalliesQuery(hours: number): string {
	return `SELECT index1 AS source,
	sum(_sample_interval) AS wins,
	quantileExactWeighted(0.5)(double1, _sample_interval) AS p50,
	quantileExactWeighted(0.95)(double1, _sample_interval) AS p95,
	max(_sample_interval) AS maxSampleInterval
	FROM FID_RACE WHERE ${buildWindow(hours)} GROUP BY index1`;
}

/** Settled races per raw-node leg (blob1), one grouped pass. */
export function buildFidLegsQuery(hours: number): string {
	return `SELECT blob1 AS leg, sum(_sample_interval) AS settled
	FROM FID_RACE WHERE ${buildWindow(hours)} GROUP BY blob1`;
}
