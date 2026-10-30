/**
 * race.ts unit tests — the shared fleet machinery (stagger, collective
 * verdicts). Real timers with small delays; the stagger bounds are
 * constants, so timing assertions are deterministic against them
 * (steps in [25, 90]ms, cumulative per leg).
 */
import { describe, expect, test } from "bun:test";

import {
	STAGGER_STEP_MAX_MS,
	STAGGER_STEP_MIN_MS,
	collectTerminals,
	collectiveRace,
	staggerDelays,
	type RaceLeg,
} from "./race.ts";

const found = <T,>(value: T): RaceLeg<T> => ({ kind: "found", value });
const miss = <T,>(fallback?: T): RaceLeg<T> => ({ kind: "miss", fallback });
const err = <T,>(message: string): RaceLeg<T> => ({
	kind: "error",
	error: new Error(message),
	fallback: undefined,
});

describe("staggerDelays", () => {
	test("leg 0 starts immediately; steps grow monotonically", () => {
		const delays = staggerDelays(5);
		expect(delays).toHaveLength(5);
		expect(delays[0]).toBe(0);
		for (let i = 1; i < delays.length; i++) {
			const step = delays[i] - delays[i - 1];
			expect(step).toBeGreaterThanOrEqual(STAGGER_STEP_MIN_MS);
			expect(step).toBeLessThanOrEqual(STAGGER_STEP_MAX_MS);
		}
	});

	test("count 0 and 1 degenerate safely", () => {
		expect(staggerDelays(0)).toEqual([]);
		expect(staggerDelays(1)).toEqual([0]);
	});

	test("jitter: two fleets rarely align", () => {
		const a = staggerDelays(6).join(",");
		const b = staggerDelays(6).join(",");
		// 5 random steps each — collision odds are ~ (1/66)^5; fine to assert.
		expect(a).not.toBe(b);
	});
});

describe("collectTerminals", () => {
	test("a found anywhere wins outright", () => {
		expect(
			collectTerminals(0, [miss("m"), found(7), err("boom")]),
		).toEqual(found(7));
	});

	test("the primary's miss fallback replays when the primary missed", () => {
		expect(collectTerminals(0, [miss("cloud-shape"), miss("potato-shape")]))
			.toEqual(miss("cloud-shape"));
	});

	test("a secondary miss's fallback is used when the primary errored", () => {
		const terminal = collectTerminals(0, [err("down"), miss("potato-shape")]);
		expect(terminal).toEqual(miss("potato-shape"));
	});

	test("all errors surface the primary's error", () => {
		const terminal = collectTerminals(0, [err("cloud down"), err("potato down")]);
		expect(terminal.kind).toBe("error");
		if (terminal.kind === "error") {
			expect((terminal.error as Error).message).toBe("cloud down");
		}
	});

	test("nothing settled ⇒ an empty miss (nothing was consulted)", () => {
		expect(collectTerminals(0, [])).toEqual(miss(undefined));
	});
});

describe("collectiveRace", () => {
	test("single leg passes through", async () => {
		const result = await collectiveRace({ legs: [() => Promise.resolve(found("x"))] });
		expect(result).toEqual(found("x"));
	});

	test("first found wins regardless of leg order", async () => {
		const result = await collectiveRace({
			legs: [
				() => new Promise((r) => setTimeout(() => r(miss("late-miss")), 40)),
				() => new Promise((r) => setTimeout(() => r(found("winner")), 10)),
			],
			delays: [0, 0],
		});
		expect(result).toEqual(found("winner"));
	});

	test("staggered starts: later legs fire after their step", async () => {
		const startedAt: number[] = [];
		const t0 = Date.now();
		await collectiveRace({
			legs: [
				() => {
					startedAt[0] = Date.now() - t0;
					return new Promise((r) => setTimeout(() => r(miss()), 1));
				},
				() => {
					startedAt[1] = Date.now() - t0;
					return new Promise((r) => setTimeout(() => r(miss()), 1));
				},
			],
			delays: [0, 60],
		});
		// Leg 1 started at least one step behind leg 0…
		expect(startedAt[1] - startedAt[0]).toBeGreaterThanOrEqual(25);
		// …and the consensus miss waited for it (total ≥ the stagger).
		expect(startedAt[1]).toBeGreaterThanOrEqual(55);
	});

	test("a fast found cancels a staggered start that never fired", async () => {
		let stragglerRan = false;
		const result = await collectiveRace({
			legs: [
				() => Promise.resolve(found("fast")),
				(): Promise<RaceLeg<string>> => {
					stragglerRan = true;
					return Promise.resolve(found("straggler"));
				},
			],
			delays: [0, 60],
		});
		expect(result).toEqual(found("fast"));
		// 150ms later the 60ms stagger would long since have fired —
		// if the race hadn't cancelled it.
		await new Promise((r) => setTimeout(r, 150));
		expect(stragglerRan).toBe(false);
	});

	test("consensus: a pending found rescues a landed miss", async () => {
		let resolveStraggler!: (r: RaceLeg<string>) => void;
		const straggler = new Promise<RaceLeg<string>>((r) => {
			resolveStraggler = r;
		});
		const raced = collectiveRace({
			legs: [() => Promise.resolve(miss("vote")), () => straggler],
			delays: [0, 0],
		});
		let settled = false;
		void raced.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false); // the miss is a vote, not the verdict
		resolveStraggler(found("rescued"));
		expect(await raced).toEqual(found("rescued"));
	});

	test("all missed ⇒ the primary's fallback replays", async () => {
		const result = await collectiveRace({
			legs: [() => Promise.resolve(miss("primary-shape")), () => Promise.resolve(miss("x"))],
			delays: [0, 0],
		});
		expect(result).toEqual(miss("primary-shape"));
	});

	test("all errored ⇒ the primary's error surfaces", async () => {
		const result = await collectiveRace({
			legs: [
				(): Promise<RaceLeg<string>> => Promise.reject(new Error("primary down")),
				(): Promise<RaceLeg<string>> => Promise.reject(new Error("other down")),
			],
			delays: [0, 0],
		});
		expect(result.kind).toBe("error");
		if (result.kind === "error") {
			expect((result.error as Error).message).toBe("primary down");
		}
	});

	test("a consulted miss beats errors when no leg found", async () => {
		const result = await collectiveRace({
			legs: [
				(): Promise<RaceLeg<string>> => Promise.reject(new Error("down")),
				() => Promise.resolve(miss("asked")),
			],
			delays: [0, 0],
		});
		expect(result).toEqual(miss("asked"));
	});
});
