/**
 * Client-rank aggregation fixtures: the weighting (first choices dominate,
 * auto-opens barely count), the warming-up share suppression, the registry
 * sort/tiebreak, and the active-registry slug filter. Pure functions —
 * no env, no I/O.
 */
import { describe, expect, test } from "bun:test";

import {
	aggregateRank,
	buildRankQuery,
	buildRankTotalsQuery,
	RANK_WEIGHTS,
	WARMING_UP_MIN,
	type RawRankRow,
} from "./client-rank-lib.ts";

const GENERATED = "2026-10-23T00:00:00.000Z";
const HOURS = 168;

const row = (
	slug: string,
	kindTransport: string,
	firstFlag: string,
	n: number,
): RawRankRow => ({ slug, kindTransport, firstFlag, n });

describe("query builders", () => {
	test("queries CLICK_STATS weighted by _sample_interval", () => {
		expect(buildRankQuery(24)).toBe(
			`SELECT index1 AS slug, blob1 AS kindTransport, blob2 AS device, blob3 AS firstFlag, sum(_sample_interval) AS n FROM CLICK_STATS WHERE timestamp > NOW() - INTERVAL '24' HOUR GROUP BY slug, kindTransport, device, firstFlag ORDER BY n DESC`,
		);
		expect(buildRankTotalsQuery(24)).toBe(
			`SELECT sum(_sample_interval) AS total, max(_sample_interval) AS maxSampleInterval FROM CLICK_STATS WHERE timestamp > NOW() - INTERVAL '24' HOUR`,
		);
	});
});

describe("aggregateRank", () => {
	test("weights kinds per the published methodology and sorts by score", () => {
		const snapshot = aggregateRank(
			[
				// farcaster: 10 first + 5 repeat + 4 auto → 10 + 1.5 + 0.4 = 11.9
				row("farcaster", "pill:native", "first", 10),
				row("farcaster", "pill:web", "repeat", 5),
				row("farcaster", "auto:native", "-", 4),
				// firefly: 2 first + 20 auto → 2 + 2 = 4
				row("firefly", "pill:web", "first", 2),
				row("firefly", "auto:web", "-", 20),
				// quilcast: 1 go-now = 0.8
				row("quilcast", "go-now:web", "-", 1),
			],
			{ total: 42, maxSampleInterval: 1 },
			HOURS,
			GENERATED,
		);
		expect(snapshot.v).toBe(1);
		expect(snapshot.window).toEqual({ hours: HOURS });
		expect(snapshot.total).toBe(42);
		expect(snapshot.sampled).toBe(false);
		expect(snapshot.warmingUp).toBe(true); // 42 < WARMING_UP_MIN
		expect(snapshot.rows.map((r) => r.id)).toEqual([
			"farcaster",
			"firefly",
			"quilcast",
		]);
		const farcaster = snapshot.rows[0];
		expect(farcaster.pill).toBe(15);
		expect(farcaster.first).toBe(10);
		expect(farcaster.repeat).toBe(5);
		expect(farcaster.auto).toBe(4);
		expect(farcaster.score).toBe(
			Math.round((10 + 5 * RANK_WEIGHTS.repeat + 4 * RANK_WEIGHTS.auto) * 100) /
				100,
		);
		// Warming up: counts shown, shares suppressed.
		expect(snapshot.rows.every((r) => r.share === null)).toBe(true);
	});

	test("first/switch flag split lands in the right buckets", () => {
		const snapshot = aggregateRank(
			[
				row("firefly", "pill:web", "first", 3),
				row("firefly", "pill:native", "switch", 2),
				row("firefly", "pill:web", "repeat", 1),
				row("firefly", "go-now:web", "-", 7),
			],
			{ total: 200, maxSampleInterval: 1 },
			HOURS,
			GENERATED,
		);
		const firefly = snapshot.rows[0];
		expect(firefly.first).toBe(3);
		expect(firefly.switched).toBe(2);
		expect(firefly.repeat).toBe(1);
		expect(firefly.pill).toBe(6);
		expect(firefly.goNow).toBe(7);
		// 200 ≥ WARMING_UP_MIN → shares published.
		expect(snapshot.warmingUp).toBe(false);
		expect(firefly.share).toBe(100);
	});

	test("shares split by score, not raw counts", () => {
		const snapshot = aggregateRank(
			[
				row("farcaster", "pill:web", "repeat", 10), // score 3
				row("firefly", "pill:web", "first", 3), // score 3
			],
			{ total: WARMING_UP_MIN, maxSampleInterval: 1 },
			HOURS,
			GENERATED,
		);
		// Equal scores; registry order tiebreak puts farcaster first.
		expect(snapshot.rows.map((r) => r.id)).toEqual(["farcaster", "firefly"]);
		expect(snapshot.rows[0].share).toBe(50);
		expect(snapshot.rows[1].share).toBe(50);
	});

	test("score tiebreak falls back to registry order", () => {
		const snapshot = aggregateRank(
			[
				row("vibeshift", "pill:web", "first", 1),
				row("farcaster", "pill:web", "first", 1),
			],
			{ total: WARMING_UP_MIN, maxSampleInterval: 1 },
			HOURS,
			GENERATED,
		);
		expect(snapshot.rows.map((r) => r.id)).toEqual(["farcaster", "vibeshift"]);
	});

	test("slugs outside the active registry are dropped, not ranked", () => {
		const snapshot = aggregateRank(
			[
				row("farcaster", "pill:web", "first", 1),
				row("deleted-client", "pill:web", "first", 50),
				row("", "pill:web", "first", 50),
			],
			{ total: 101, maxSampleInterval: 1 },
			HOURS,
			GENERATED,
		);
		expect(snapshot.rows.map((r) => r.id)).toEqual(["farcaster"]);
	});

	test("sampled flag rides the max _sample_interval", () => {
		const snapshot = aggregateRank(
			[row("farcaster", "pill:web", "first", 5)],
			{ total: 5, maxSampleInterval: 3 },
			HOURS,
			GENERATED,
		);
		expect(snapshot.sampled).toBe(true);
	});

	test("garbage rows are ignored without taking the snapshot down", () => {
		const snapshot = aggregateRank(
			[
				{ slug: 42, kindTransport: null, firstFlag: undefined, n: "abc" },
				row("firefly", "weird", "-", 2), // unknown kindTransport → no bucket
			],
			{ total: 0, maxSampleInterval: 0 },
			HOURS,
			GENERATED,
		);
		// firefly appeared but accrued nothing → absent from rows entirely.
		expect(snapshot.rows).toEqual([]);
		expect(snapshot.total).toBe(0);
		expect(snapshot.warmingUp).toBe(true);
	});
});
