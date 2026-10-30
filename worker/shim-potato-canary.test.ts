/**
 * Shim-potato FLEET — the regional legs' contract (SPOF softened Oct 2026,
 * successor to the PLAN8 canary guards):
 *  - roster assembly: one provider per comma-separated base, ids
 *    shim-potato / shim-potato-2 / …;
 *  - a fleet member's FOUND wins like any complete provider;
 *  - a fleet member's MISS is a parity VOTE: not-found needs consensus
 *    (every miss-authoritative leg consulted and missed) — no single host
 *    decides, so a pending leg can always rescue a landed miss;
 *  - shim's miss is no longer fast-terminal (regression guard, flipped
 *    deliberately: cloud retires into the fleet).
 * No mock.module dance: cast-source.ts pulls in shim.ts + radash only.
 * Stubs settle via real (short) timers; raceCast's 5s caps never fire.
 */
import { describe, expect, test } from "bun:test";

import {
	type CastProvider,
	PROVIDERS,
	raceCast,
	raceRoster,
	shimPotatoProvider,
	type ProviderId,
	type ProviderResult,
	shimProvider,
} from "./cast-source.ts";

const SIGNAL = new AbortController().signal;

/** A complete stub whose successive fetches play back a fixed script. */
function stub(
	id: ProviderId,
	script: Array<{ ms: number; result: ProviderResult }>,
	missAuthoritative?: boolean,
): CastProvider {
	let call = 0;
	return {
		id,
		complete: true,
		missAuthoritative,
		canServe: () => true,
		fetchCast() {
			const step = script[Math.min(call++, script.length - 1)];
			return new Promise<ProviderResult>((resolve) =>
				setTimeout(() => resolve(step.result), step.ms),
			);
		},
	};
}

const found = (id: ProviderId): ProviderResult => ({
	kind: "found",
	provider: id,
	complete: true,
	cast: {
		fid: 1,
		hash: "0xabcdef0123456789abcdef0123456789abcdef01",
		text: "hi",
		timestamp: 1700000000,
		embeds: [],
		user: { fid: 1, username: "zoo" },
	},
});

describe("raceRoster", () => {
	test("no host → undefined (raceCast's default roster)", () => {
		expect(raceRoster(undefined)).toBeUndefined();
		expect(raceRoster("")).toBeUndefined();
	});

	test("one host → default four plus a shim-potato tail", () => {
		const roster = raceRoster("https://shim-potato.test");
		expect(roster?.map((p) => p.id)).toEqual([
			"shim",
			"haatz",
			"snap",
			"farcaster-tv",
			"shim-potato",
		]);
		// Full fleet membership: the leg's misses are parity votes.
		const shimPotato = roster?.at(-1);
		expect(shimPotato?.missAuthoritative).toBe(true);
		expect(shimProvider.missAuthoritative).toBe(true);
	});

	test("comma-separated fleet → one numbered leg per base", () => {
		const roster = raceRoster(
			"https://shim-potato.test, https://shim-potato-2.test ,https://shim-potato.test",
		);
		expect(roster?.map((p) => p.id)).toEqual([
			"shim",
			"haatz",
			"snap",
			"farcaster-tv",
			"shim-potato",
			"shim-potato-2",
		]);
		// The duplicate base was dropped, not mapped twice.
		expect(roster?.at(-1)?.canServe).toBeDefined();
		expect(raceRoster("https://shim.artlu.xyz")).toBeUndefined();
	});
});

describe("fleet race semantics", () => {
	test("a fleet member's found wins head-to-head against a slower shim", async () => {
		const race = await raceCast(
			{ username: "zoo", hash: "0xabcdef01" },
			{
				boxMs: 700,
				providers: [
					stub("shim", [{ ms: 300, result: found("shim") }]),
					stub("shim-potato", [{ ms: 5, result: found("shim-potato") }]),
				],
			},
		);
		expect(race.kind).toBe("found");
		if (race.kind === "found") {
			expect(race.provider).toBe("shim-potato");
			expect(race.partial).toBe(false);
		}
	});

	test("a pending found rescues a landed miss (shim's miss is a vote, not a verdict)", async () => {
		const race = await raceCast(
			{ username: "zoo", hash: "0xabcdef01" },
			{
				boxMs: 700,
				providers: [
					stub("shim", [{ ms: 1, result: { kind: "miss", provider: "shim" } }]),
					stub("shim-potato", [{ ms: 50, result: found("shim-potato") }]),
				],
			},
		);
		expect(race.kind).toBe("found");
		if (race.kind === "found") expect(race.provider).toBe("shim-potato");
	});

	test("consensus: every miss-authoritative leg missed ⇒ not-found", async () => {
		const race = await raceCast(
			{ username: "zoo", hash: "0xabcdef01" },
			{
				boxMs: 700,
				providers: [
					stub("shim", [{ ms: 1, result: { kind: "miss", provider: "shim" } }]),
					stub("shim-potato", [
						{ ms: 5, result: { kind: "miss", provider: "shim-potato" } },
					]),
					stub("haatz", [{ ms: 20, result: { kind: "miss", provider: "haatz" } }]),
					stub("snap", [{ ms: 25, result: { kind: "miss", provider: "snap" } }]),
				],
			},
		);
		expect(race.kind).toBe("not-found");
	});

	test("a consulted miss beats errors: fleet miss + everyone errors ⇒ not-found", async () => {
		const race = await raceCast(
			{ username: "zoo", hash: "0xabcdef01" },
			{
				boxMs: 700,
				providers: [
					stub("shim", [{ ms: 20, result: { kind: "error", provider: "shim", message: "HTTP 500" } }]),
					stub("shim-potato", [
						{ ms: 1, result: { kind: "miss", provider: "shim-potato" } },
					]),
					stub("haatz", [{ ms: 25, result: { kind: "error", provider: "haatz", message: "HTTP 500" } }]),
					stub("snap", [{ ms: 30, result: { kind: "error", provider: "snap", message: "HTTP 500" } }]),
				],
			},
		);
		// The network was asked (by the fleet member) — a 404 verdict,
		// not a 503. The miss stays visible in telemetry either way.
		expect(race.kind).toBe("not-found");
		const shimPotatoRow = race.timings.find((t) => t.provider === "shim-potato");
		expect(shimPotatoRow?.kind).toBe("miss");
	});

	test("all legs error ⇒ unreachable", async () => {
		const race = await raceCast(
			{ username: "zoo", hash: "0xabcdef01" },
			{
				boxMs: 700,
				providers: [
					stub("shim", [{ ms: 20, result: { kind: "error", provider: "shim", message: "HTTP 500" } }]),
					stub("shim-potato", [
						{ ms: 1, result: { kind: "error", provider: "shim-potato", message: "HTTP 500" } },
					]),
				],
			},
		);
		expect(race.kind).toBe("unreachable");
	});
});

describe("shimPotatoProvider factory", () => {
	const realFetch = globalThis.fetch;

	function route(respond: Map<string, unknown>) {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			const body = respond.get(url);
			if (body === undefined) throw new Error(`unexpected fetch ${url}`);
			return new Response(JSON.stringify(body), { status: 200 });
		}) as typeof fetch;
	}

	test("races the configured host with the canonical contract", async () => {
		route(
			new Map([
				[
					"https://shim-potato.test/wc/zoo/0xabc",
					{
						success: true,
						cast: {
							fid: 1,
							hash: "0xabcdef0123456789abcdef0123456789abcdef01",
							text: "hi",
							timestamp: 1700000000,
							embeds: [],
							user: { fid: 1, username: "zoo" },
						},
					},
				],
				["https://shim-potato.test/wc/empty/0xabc", { success: false }],
			]),
		);
		try {
			const p = shimPotatoProvider("https://shim-potato.test");
			const hit = await p.fetchCast(
				{ username: "zoo", hash: "0xabc" },
				SIGNAL,
			);
			expect(hit.kind).toBe("found");
			if (hit.kind === "found") {
				expect(hit.provider).toBe("shim-potato");
				expect(hit.complete).toBe(true);
				expect(hit.cast.hash.startsWith("0xabc")).toBe(true);
			}
			const miss = await p.fetchCast(
				{ username: "empty", hash: "0xabc" },
				SIGNAL,
			);
			expect(miss).toEqual({ kind: "miss", provider: "shim-potato" });
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

// The default roster is untouched by the fleet: four providers, and the
// module-level shim provider still carries miss authority (as one vote).
describe("default roster", () => {
	test("PROVIDERS stays the static four until activation", () => {
		expect(PROVIDERS.map((p) => p.id)).toEqual([
			"shim",
			"haatz",
			"snap",
			"farcaster-tv",
		]);
	});
});
