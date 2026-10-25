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
	v: 1,
	generatedAt: "2026-10-25T00:00:00.000Z",
	window: { hours: 168 },
	sampled: false,
	sources: {
		shim: { wins: 12, p50Ms: 8, p95Ms: 30 },
		node: { wins: 40, p50Ms: 5, p95Ms: 22 },
	},
	legs: { haatz: 30, snap: 22 },
};

describe("validateFidSnapshot", () => {
	test("accepts the v:1 snapshot, rejects garbage and half-shapes", () => {
		expect(validateFidSnapshot(SNAPSHOT)).not.toBeNull();
		expect(validateFidSnapshot(null)).toBeNull();
		expect(validateFidSnapshot("nope")).toBeNull();
		expect(validateFidSnapshot({ v: 2, sources: {}, legs: {} })).toBeNull();
		// Recognizable v but missing the sources/legs halves → ignored.
		expect(validateFidSnapshot({ v: 1 })).toBeNull();
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
