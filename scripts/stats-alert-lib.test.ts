import { describe, expect, test } from "bun:test";

import type { Snapshot } from "./race-stats-lib.ts";
import { providerBreaches, snapshotProblems } from "./stats-alert-lib.ts";

const limits = { p95Max: 2000, errMax: 0.05 };

const provider = (
	over: Partial<Snapshot["providers"][number]>,
): Snapshot["providers"][number] => ({
	id: "shim",
	role: "complete",
	wins: 10,
	requests: 100,
	p50Ms: 120,
	p95Ms: 400,
	errorRate: 0.01,
	...over,
});

describe("providerBreaches", () => {
	test("stays quiet under both limits", () => {
		expect(providerBreaches([provider({})], limits)).toEqual([]);
	});

	test("names an error-rate breach with the 5.0% line", () => {
		expect(providerBreaches([provider({ errorRate: 0.1665 })], limits)).toEqual(
			["shim: err 16.65% > 5.0%"],
		);
	});

	test("names p95 and error rate on one line", () => {
		expect(
			providerBreaches(
				[provider({ id: "shim-potato-2", p95Ms: 3503, errorRate: 0.0642 })],
				limits,
			),
		).toEqual(["shim-potato-2: p95 3503ms > 2000ms, err 6.42% > 5.0%"]);
	});

	test("skips a provider that was not consulted, and a null p95", () => {
		expect(
			providerBreaches(
				[
					provider({ id: "idle", requests: 0, errorRate: 1, p95Ms: 9000 }),
					provider({ id: "haatz", p95Ms: null, errorRate: 0 }),
				],
				limits,
			),
		).toEqual([]);
	});
});

describe("snapshotProblems", () => {
	test("a fresh key is quiet; missing, unreadable, and stale keys speak", () => {
		const now = Date.parse("2026-11-23T12:00:00.000Z");
		const fresh = new Date(now - 2 * 3_600_000).toISOString();
		const old = new Date(now - 50 * 3_600_000).toISOString();
		expect(
			snapshotProblems(
				[
					["race-stats", { kind: "ok", generatedAt: fresh }],
					["client-rank", { kind: "bad", reason: "missing key" }],
					["fid-race", { kind: "ok", generatedAt: old }],
					["other", { kind: "ok", generatedAt: null }],
				],
				now,
				48,
			),
		).toEqual([
			"client-rank: unreadable (missing key)",
			"fid-race: stale — generatedAt 2026-11-21T10:00:00.000Z (50h old > 48h)",
			"other: unparseable generatedAt",
		]);
	});
});
