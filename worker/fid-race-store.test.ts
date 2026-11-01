/**
 * Fid-race snapshot store tests — compact mirror of
 * race-stats-store.test.ts: the v/shape gate and the healthy/degraded
 * read paths, with injected transport (no real lmdis, no real time).
 */
import { describe, expect, test } from "bun:test";

import {
	createFidRaceStore,
	validateFidSnapshot,
} from "./fid-race-store.ts";

const SNAPSHOT = {
	v: 2,
	generatedAt: "2026-10-25T00:00:00.000Z",
	window: { hours: 168 },
	sampled: false,
	sources: {
		shim: { wins: 12, p50Ms: 8, p95Ms: 30 },
		haatz: { wins: 9, p50Ms: 11, p95Ms: 40 },
		snap: { wins: 31, p50Ms: 5, p95Ms: 22 },
		"shim-potato": { wins: 7, p50Ms: 6, p95Ms: 25 },
	},
	legs: { haatz: 30, snap: 29 },
};

describe("validateFidSnapshot", () => {
	test("accepts the v:2 open-vocabulary snapshot, rejects garbage and half-shapes", () => {
		expect(validateFidSnapshot(SNAPSHOT)).not.toBeNull();
		expect(validateFidSnapshot(null)).toBeNull();
		expect(validateFidSnapshot("nope")).toBeNull();
		// v:1 predates the per-member fleet ids — ignored, never half-parsed.
		expect(
			validateFidSnapshot({ ...SNAPSHOT, v: 1, sources: { shim: SNAPSHOT.sources.shim, haatz: SNAPSHOT.sources.haatz, snap: SNAPSHOT.sources.snap } }),
		).toBeNull();
		// Recognizable v but missing the sources/legs halves → ignored.
		expect(validateFidSnapshot({ v: 2 })).toBeNull();
		// A source row without a numeric wins count is a half-shape.
		expect(
			validateFidSnapshot({
				...SNAPSHOT,
				sources: { ...SNAPSHOT.sources, junk: { p50Ms: 1 } },
			}),
		).toBeNull();
	});
});

test("healthy lmdis serves the snapshot; missing key degrades to null", async () => {
	const healthy = createFidRaceStore({
		url: "https://lmdis.test",
		token: "tok",
		fetchFn: () => Promise.resolve(Response.json({ result: JSON.stringify(SNAPSHOT) })),
	});
	expect(await healthy.get()).toEqual(SNAPSHOT);

	const missing = createFidRaceStore({
		url: "https://lmdis.test",
		token: "tok",
		fetchFn: () => Promise.resolve(Response.json({ result: null })),
	});
	expect(await missing.get()).toBeNull();

	const down = createFidRaceStore({
		url: "https://lmdis.test",
		token: "tok",
		fetchFn: () => Promise.reject(new Error("lmdis down")),
	});
	expect(await down.get()).toBeNull();
});
