// Race-stats query builders — pure functions, no env, no I/O, so the
// fixture tests (race-stats-lib.test.ts) can import this safely.
//
// Every SQL shape here is verified against the live AE dialect
// (scripts/probe/ae.ts, Oct 2026): no CONCAT (use format()), only
// toUInt32/toUInt8 conversions, position(needle IN haystack) syntax,
// countIf/sumIf/quantileExactWeighted with _sample_interval weights.

/** Static roster — keep in sync with worker/transparency.tsx (near-static
 * by design). Seat ids are hostname labels (worker/shim.ts fleetSeatId),
 * not var positions: a host that leaves keeps its series, and nobody else
 * inherits it. Add a row when a new hostname joins; leave a row in place
 * when a host is out, so its history and its return stay one series.
 * "shim" is the self-hosted potato at shim.artlu.xyz — fleet lead since
 * the Nov 9 2026 cutover (the row predates that as the pre-cutover id,
 * trimmed Nov 6 when it aged out; revived at the cutover).
 * "shim-potato" is shim-potato.artlu.xyz — back from its Nov 7
 * re-deploy, second in the var.
 * "shim-potato-2" is that host. "shim-potato-4" / "-5" were dropped from
 * the var Nov 9 2026 — the rows stay so their history keeps decaying
 * under its own id (and a return resumes the same series).
 * "shim-potato-3" is NOT a host. Cloud's first days wrote that id under
 * the old positional scheme. Keep the row while those points decay
 * (~Nov 12); never give a new machine this name, or its points blend
 * into cloud's series.
 * "shim-cloud" is retired (Render host decommissioned Nov 2026; the
 * hostname's seat became "shim" at the Nov 9 cutover) — no new
 * datapoints ever; trim after the window. */
export const ROSTER = [
	{ id: "shim", role: "complete" },
	{ id: "shim-potato", role: "complete" },
	{ id: "shim-potato-2", role: "complete" },
	{ id: "shim-cloud", role: "complete" },
	{ id: "shim-potato-3", role: "complete" },
	{ id: "shim-potato-4", role: "complete" },
	{ id: "shim-potato-5", role: "complete" },
	{ id: "haatz", role: "complete" },
	{ id: "snap", role: "complete" },
	{ id: "farcaster-tv", role: "partial" },
] as const;

export type ProviderRole = (typeof ROSTER)[number]["role"];

const KINDS = ["found", "miss", "error", "abort"] as const;

/** Identifier-safe column alias (dataset ids contain hyphens; aliases must not). */
export const tallyAlias = (provider: string, kind: string): string =>
	`${provider.replace(/-/g, "_")}_${kind}`;

/** Extracts one provider's `ms` field from blob1's `provider:kind:ms` rows. */
export function msExpr(provider: string): string {
	const prefix = `${provider}:`;
	const s = `substring(blob1, position('${prefix}' IN blob1) + ${prefix.length})`;
	const t = `substring(${s}, position(':' IN ${s}) + 1)`;
	const tc = `format('{},', ${t})`;
	return `toUInt32(substring(${tc}, 1, position(',' IN ${tc}) - 1))`;
}

export function buildWindow(hours: number): string {
	return `timestamp > NOW() - INTERVAL '${hours}' HOUR`;
}

/** Weighted rows per index1 — winner ids plus not-found/unreachable outcomes. */
export function buildOutcomesQuery(hours: number): string {
	return `SELECT index1 AS outcome, sum(_sample_interval) AS n FROM RACE_STATS WHERE ${buildWindow(hours)} GROUP BY outcome ORDER BY n DESC`;
}

/** Per-provider found/miss/error/abort tallies + the sampling ceiling, one row. */
export function buildTalliesQuery(hours: number): string {
	const cols = ROSTER.flatMap((p) =>
		KINDS.map(
			(kind) =>
				`sumIf(_sample_interval, position('${p.id}:${kind}:' IN blob1) > 0) AS ${tallyAlias(p.id, kind)}`,
		),
	);
	cols.push("max(_sample_interval) AS maxSampleInterval");
	return `SELECT ${cols.join(", ")} FROM RACE_STATS WHERE ${buildWindow(hours)}`;
}

/** Weighted p50/p95 (+ sample count) for one provider's settled latencies. */
export function buildLatencyQuery(provider: string, hours: number): string {
	return `SELECT quantileExactWeighted(0.5)(${msExpr(provider)}, _sample_interval) AS p50,
		quantileExactWeighted(0.95)(${msExpr(provider)}, _sample_interval) AS p95,
		sum(_sample_interval) AS samples
	FROM RACE_STATS WHERE ${buildWindow(hours)} AND position('${provider}:' IN blob1) > 0`;
}

/** The transparency snapshot contract — see README "Race stats (/transparency)". */
export type Snapshot = {
	v: 1;
	generatedAt: string;
	window: { hours: number };
	sampled: boolean;
	outcomes: { found: number; notFound: number; unreachable: number };
	providers: Array<{
		id: string;
		role: ProviderRole;
		wins: number;
		requests: number;
		p50Ms: number | null;
		p95Ms: number | null;
		errorRate: number;
	}>;
};
