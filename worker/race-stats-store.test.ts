/**
 * Race-stats store unit tests: TTL caching, silent-degrade (missing key /
 * unknown shape / lmdis unreachable), stale-while-error (≤24h), the 60s
 * failure backoff, and single-flight. Clock and transport are injected —
 * no real lmdis, no real time.
 */
import { describe, expect, test } from "bun:test";

import {
	createRaceStatsStore,
	validateSnapshot,
	type Snapshot,
} from "./race-stats-store.ts";

const SNAPSHOT: Snapshot = {
	v: 1,
	generatedAt: "2026-10-21T23:24:55.953Z",
	window: { hours: 168 },
	sampled: false,
	outcomes: { found: 101, notFound: 1, unreachable: 0 },
	providers: [
		{
			id: "shim",
			role: "complete",
			wins: 18,
			requests: 102,
			p50Ms: 700,
			p95Ms: 701,
			errorRate: 0.8137,
		},
	],
};

type Fake = {
	/** What lmdis holds for the key right now (read fresh on each fetch). */
	holder: { stored: string | null; fail: boolean };
	calls: { n: number };
	now: () => number;
};

function makeStore(fake: Fake) {
	return createRaceStatsStore({
		url: "https://lmdis.test",
		token: "tok",
		now: fake.now,
		fetchFn: (async () => {
			fake.calls.n += 1;
			if (fake.holder.fail) return new Response("boom", { status: 500 });
			return Response.json({ result: fake.holder.stored });
		}) as unknown as typeof fetch,
	});
}

describe("validateSnapshot", () => {
	test("accepts v:1 snapshots and rejects everything else", () => {
		expect(validateSnapshot(SNAPSHOT)).not.toBeNull();
		expect(validateSnapshot(null)).toBeNull();
		expect(validateSnapshot("json-string")).toBeNull();
		expect(validateSnapshot({})).toBeNull();
		expect(validateSnapshot({ ...SNAPSHOT, v: 2 })).toBeNull();
		expect(validateSnapshot({ ...SNAPSHOT, providers: "nope" })).toBeNull();
	});
});

describe("createRaceStatsStore", () => {
	test("serves the snapshot and caches within the TTL", async () => {
		let t = 1000;
		const fake: Fake = {
			holder: { stored: JSON.stringify(SNAPSHOT), fail: false },
			calls: { n: 0 },
			now: () => t,
		};
		const store = makeStore(fake);
		const first = await store.get();
		expect(first).toEqual(SNAPSHOT);
		t += 60_000; // 1 min later — inside the 10 min TTL
		const second = await store.get();
		expect(second).toEqual(SNAPSHOT);
		expect(fake.calls.n).toBe(1); // no refetch
	});

	test("missing key → null (dashes), and clears a previously good value", async () => {
		let t = 1000;
		const fake: Fake = {
			holder: { stored: JSON.stringify(SNAPSHOT), fail: false },
			calls: { n: 0 },
			now: () => t,
		};
		const store = makeStore(fake);
		expect(await store.get()).toEqual(SNAPSHOT);
		t += 11 * 60_000; // past TTL → refetch
		fake.holder.stored = null; // snapshot removed from lmdis
		expect(await store.get()).toBeNull(); // authoritative missing key
	});

	test("lmdis unreachable → null without a prior value; backoff bounds attempts", async () => {
		let t = 1000;
		const fake: Fake = {
			holder: { stored: null, fail: true },
			calls: { n: 0 },
			now: () => t,
		};
		const store = makeStore(fake);
		expect(await store.get()).toBeNull();
		t += 30_000; // inside the 60s backoff
		await store.get();
		expect(fake.calls.n).toBe(1); // no extra attempt
		t += 31_000; // past the backoff
		await store.get();
		expect(fake.calls.n).toBe(2); // retried
	});

	test("stale-while-error: last good value serves ≤24h, then dashes", async () => {
		let t = 1000;
		const fake: Fake = {
			holder: { stored: JSON.stringify(SNAPSHOT), fail: false },
			calls: { n: 0 },
			now: () => t,
		};
		const store = makeStore(fake);
		expect(await store.get()).toEqual(SNAPSHOT);
		t += 11 * 60_000; // past TTL
		fake.holder.fail = true; // lmdis goes down
		expect(await store.get()).toEqual(SNAPSHOT); // stale served
		t += 25 * 60 * 60_000; // past the 24h stale window
		expect(await store.get()).toBeNull(); // give up → dashes
	});

	test("unrecognized shape after a successful fetch → dashes", async () => {
		const t = 1000;
		const fake: Fake = {
			holder: { stored: JSON.stringify({ ...SNAPSHOT, v: 99 }), fail: false },
			calls: { n: 0 },
			now: () => t,
		};
		const store = makeStore(fake);
		expect(await store.get()).toBeNull();
	});

	test("concurrent gets collapse into one fetch (single-flight)", async () => {
		const fake: Fake = {
			holder: { stored: JSON.stringify(SNAPSHOT), fail: false },
			calls: { n: 0 },
			now: () => 1000,
		};
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const store = createRaceStatsStore({
			url: "https://lmdis.test",
			token: "tok",
			now: fake.now,
			fetchFn: (async () => {
				fake.calls.n += 1;
				await gate;
				return Response.json({ result: fake.holder.stored });
			}) as unknown as typeof fetch,
		});
		const p1 = store.get();
		const p2 = store.get();
		release();
		const [a, b] = await Promise.all([p1, p2]);
		expect(a).toEqual(SNAPSHOT);
		expect(b).toEqual(SNAPSHOT);
		expect(fake.calls.n).toBe(1);
	});
});
