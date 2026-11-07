/**
 * Shim-potato FLEET — the regional legs' contract (SPOF softened Oct 2026,
 * successor to the canary-era guards):
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
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { SHIM_CLOUD_BASE, fleetBases } from "./shim.ts";

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
	test("no var → the legacy static roster, cloud-led", () => {
		expect(raceRoster(undefined).map((p) => p.id)).toEqual([
			"shim",
			"haatz",
			"snap",
			"farcaster-tv",
		]);
		expect(raceRoster("").map((p) => p.id)).toEqual([
			"shim",
			"haatz",
			"snap",
			"farcaster-tv",
		]);
	});

	test("one host → the raw nodes, farcaster-tv, then the fleet tail", () => {
		const roster = raceRoster("https://shim-potato.test");
		expect(roster.map((p) => p.id)).toEqual([
			"haatz",
			"snap",
			"farcaster-tv",
			"shim-potato",
		]);
		// Full fleet membership: the leg's misses are parity votes.
		const shimPotato = roster.at(-1);
		expect(shimPotato?.missAuthoritative).toBe(true);
		expect(shimProvider.missAuthoritative).toBe(true);
	});

	test("comma-separated fleet → one numbered leg per base", () => {
		const roster = raceRoster(
			"https://shim-potato.test, https://shim-potato-2.test ,https://shim-potato.test",
		);
		expect(roster.map((p) => p.id)).toEqual([
			"haatz",
			"snap",
			"farcaster-tv",
			"shim-potato",
			"shim-potato-2",
		]);
		// The duplicate base was dropped, not mapped twice.
		expect(roster.at(-1)?.canServe).toBeDefined();
	});

	test("cloud's base rides the var under its own name — it is not a potato", () => {
		const roster = raceRoster("https://shim-potato.test,https://shim.artlu.xyz");
		expect(roster.map((p) => p.id)).toEqual([
			"haatz",
			"snap",
			"farcaster-tv",
			"shim-potato",
			"shim-cloud",
		]);
		// The threaded raw legs carry the fleet race into the identity
		// stage; roster assembly stays provider-shape-identical.
		expect(raceRoster("https://shim.artlu.xyz").at(-1)?.id).toBe(
			"shim-cloud",
		);
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

	test("the fleet LEADS: a potato wins head-to-head against a slower shim", async () => {
		// Fleet legs start at 0ms (shim trails a step) and answer in 5ms —
		// they beat shim's 300ms response outright.
		const race = await raceCast(
			{ username: "zoo", hash: "0xabcdef01" },
			{
				boxMs: 700,
				providers: [
					stub("shim", [{ ms: 300, result: found("shim") }]),
					stub("shim-potato", [{ ms: 5, result: found("shim-potato") }]),
					stub("shim-potato-2", [{ ms: 5, result: found("shim-potato-2") }]),
				],
			},
		);
		expect(race.kind).toBe("found");
		if (race.kind === "found") {
			expect(race.provider.startsWith("shim-potato")).toBe(true);
			expect(race.partial).toBe(false);
		}
	});

	test("a fast fleet win cancels the trailing shim start", async () => {
		const race = await raceCast(
			{ username: "zoo", hash: "0xabcdef01" },
			{
				boxMs: 700,
				providers: [
					stub("shim", [{ ms: 1, result: found("shim") }]),
					stub("shim-potato", [{ ms: 5, result: found("shim-potato") }]),
					stub("shim-potato-2", [{ ms: 5, result: found("shim-potato-2") }]),
				],
			},
		);
		// The fleet won at ~5ms — shim's stagger (≥25ms) was cleared before
		// firing, so only the winner ever appears in telemetry.
		expect(race.kind).toBe("found");
		expect(race.timings.map((t) => t.provider)).toEqual(["shim-potato"]);
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

/**
 * The production fleet var, asserted BY CONTRACT (the roster-guard rule):
 * the shim-cloud retirement (Nov 2026) pruned cloud's base — these tests
 * fail if a var edit ever re-adds it, so the retired host stays retired
 * and generates no new "shim-cloud" datapoints. The exact-fleet guard
 * makes every membership change deliberate: update EXPECTED_FLEET in the
 * same commit as the var.
 */
describe("production fleet var (shim-cloud retirement)", () => {
	const varSource = readFileSync(
		join(import.meta.dir, "../wrangler.jsonc"),
		"utf8",
	);
	const varMatch = varSource.match(/"SHIM_POTATO_BASE"\s*:\s*"([^"]+)"/);
	const bases = fleetBases(varMatch?.[1] ?? null);

	test("the var is set and parses to a non-empty fleet", () => {
		expect(varMatch).toBeDefined();
		expect(bases.length).toBeGreaterThan(0);
	});

	test("every base is https", () => {
		for (const base of bases) expect(base.startsWith("https://")).toBe(true);
	});

	test("no cloud base — the retired host never races again", () => {
		expect(bases).not.toContain(SHIM_CLOUD_BASE);
	});

	// TEMPORARY (Nov 7 2026): the lead (shim-potato.artlu.xyz) is out
	// while it re-deploys. Restoring it means putting it back at the
	// FRONT — order is the stagger/primary order, and the seats are
	// positional (the new hosts shim-potato-4/-5 race as ids
	// shim-potato-3/-4 only once the lead is back at index 0).
	test("fleet membership is exactly this list, in this order", () => {
		expect(bases).toEqual([
			"https://shim-potato-2.artlu.xyz",
			"https://shim-potato-4.artlu.xyz",
			"https://shim-potato-5.artlu.xyz",
		]);
	});
});
