// Client-rank query builders + aggregation — pure functions, no env, no
// I/O, so fixture tests (client-rank-lib.test.ts) can import this safely.
// SQL conventions verified against the live AE dialect (see race-stats-lib.ts):
// sumIf/sum with _sample_interval weights, position() syntax, no CONCAT.
//
// Weighting (PLAN3 §3) exists to defuse the auto-open feedback loop: auto
// events echo an earlier choice, so they count ~10x less than a deliberate
// first choice. Weights are published next to the numbers on /transparency.

import { CLIENTS } from "../worker/client-registry.ts";

/** Active client ids, registry order — the sort tiebreak + slug whitelist. */
export const RANK_IDS = CLIENTS.filter(
	(client) => client.status === undefined || client.status === "active",
).map((client) => client.id);

/**
 * Score weights by event kind. first/switch = a deliberate new choice
 * (the purest popularity signal); repeat = habit; go-now = explicit but
 * same-client-biased; auto = an echo of an earlier choice.
 */
export const RANK_WEIGHTS = {
	first: 1.0,
	switched: 1.0,
	repeat: 0.3,
	goNow: 0.8,
	auto: 0.1,
} as const;

/** Below this window total, shares are suppressed (`warming-up`). */
export const WARMING_UP_MIN = 100;

export function buildRankWindow(hours: number): string {
	return `timestamp > NOW() - INTERVAL '${hours}' HOUR`;
}

/** Weighted rows per (slug, kind:transport, device, first-flag). */
export function buildRankQuery(hours: number): string {
	return `SELECT index1 AS slug, blob1 AS kindTransport, blob2 AS device, blob3 AS firstFlag, sum(_sample_interval) AS n FROM CLICK_STATS WHERE ${buildRankWindow(hours)} GROUP BY slug, kindTransport, device, firstFlag ORDER BY n DESC`;
}

/** One row: weighted event total + the sampling ceiling. */
export function buildRankTotalsQuery(hours: number): string {
	return `SELECT sum(_sample_interval) AS total, max(_sample_interval) AS maxSampleInterval FROM CLICK_STATS WHERE ${buildRankWindow(hours)}`;
}

/** The client-rank snapshot contract — see PLAN3 §6 and /transparency. */
export type RankRow = {
	id: string;
	/** Explicit pill picks with no saved client (`first` flag). */
	first: number;
	/** Explicit pill picks that changed the saved client. */
	switched: number;
	/** Explicit pill picks repeating the saved client. */
	repeat: number;
	/** All explicit pill picks (first + switched + repeat). */
	pill: number;
	/** Paused-view "Go now" / countdown-link opens. */
	goNow: number;
	/** Timer-fired auto-open redirects. */
	auto: number;
	/** Weighted popularity score (RANK_WEIGHTS), 2 decimals. */
	score: number;
	/** Share of total score, percent (1 decimal); null while warming up. */
	share: number | null;
};

export type RankSnapshot = {
	v: 1;
	generatedAt: string;
	window: { hours: number };
	sampled: boolean;
	/** Weighted event count in the window (all kinds). */
	total: number;
	/** total < WARMING_UP_MIN: counts shown, shares suppressed. */
	warmingUp: boolean;
	/** Observed clients only, sorted by score desc (registry tiebreak). */
	rows: RankRow[];
};

export interface RawRankRow {
	slug: unknown;
	kindTransport: unknown;
	firstFlag: unknown;
	n: unknown;
}

const num = (value: unknown): number => {
	const n = Number(value ?? 0);
	return Number.isFinite(n) ? n : 0;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Aggregates weighted AE rows into the snapshot. Rows for slugs outside
 * the active registry are dropped (defense in depth — the /t allow-list
 * already rejects them; a client that goes eol mid-window disappears
 * from the rank instead of haunting it). Tiebreak is registry order so a
 * quiet week can't scramble the row.
 */
export function aggregateRank(
	raw: RawRankRow[],
	totals: { total: unknown; maxSampleInterval: unknown },
	hours: number,
	generatedAt: string,
): RankSnapshot {
	const order = new Map(RANK_IDS.map((id, i) => [id, i]));
	interface Acc {
		first: number;
		switched: number;
		repeat: number;
		goNow: number;
		auto: number;
	}
	const bySlug = new Map<string, Acc>();
	for (const row of raw) {
		const slug = typeof row.slug === "string" ? row.slug : "";
		if (!order.has(slug)) continue;
		const kindTransport = typeof row.kindTransport === "string" ? row.kindTransport : "";
		const kind = kindTransport.slice(0, kindTransport.indexOf(":"));
		const firstFlag = typeof row.firstFlag === "string" ? row.firstFlag : "";
		const n = num(row.n);
		const acc =
			bySlug.get(slug) ?? { first: 0, switched: 0, repeat: 0, goNow: 0, auto: 0 };
		if (kind === "pill") {
			if (firstFlag === "first") acc.first += n;
			else if (firstFlag === "switch") acc.switched += n;
			else acc.repeat += n;
		} else if (kind === "go-now") {
			acc.goNow += n;
		} else if (kind === "auto") {
			acc.auto += n;
		}
		bySlug.set(slug, acc);
	}

	const total = num(totals.total);
	const warmingUp = total < WARMING_UP_MIN;
	const rows = Array.from(bySlug.entries())
		.map(([id, acc]): RankRow => {
			const pill = acc.first + acc.switched + acc.repeat;
			const score = round2(
				RANK_WEIGHTS.first * acc.first +
					RANK_WEIGHTS.switched * acc.switched +
					RANK_WEIGHTS.repeat * acc.repeat +
					RANK_WEIGHTS.goNow * acc.goNow +
					RANK_WEIGHTS.auto * acc.auto,
			);
			return {
				id,
				first: acc.first,
				switched: acc.switched,
				repeat: acc.repeat,
				pill,
				goNow: acc.goNow,
				auto: acc.auto,
				score,
				share: null,
			};
		})
		// An observed slug that classified into no bucket (mid-window schema
		// drift is the only way past the /t allow-list) carries no
		// information — drop it instead of ranking a zero.
		.filter((row) => row.pill + row.goNow + row.auto > 0)
		.sort(
			(a, b) =>
				b.score - a.score || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
		);
	if (!warmingUp) {
		const scoreSum = rows.reduce((sum, r) => sum + r.score, 0);
		if (scoreSum > 0) {
			for (const row of rows) {
				row.share = Math.round((row.score / scoreSum) * 1000) / 10;
			}
		}
	}
	return {
		v: 1,
		generatedAt,
		window: { hours },
		sampled: num(totals.maxSampleInterval) > 1,
		total,
		warmingUp,
		rows,
	};
}
