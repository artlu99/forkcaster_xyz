/**
 * PLAN8 shim-potato canary — the measurement leg's contract:
 *  - roster assembly: shim-potato only when the host is configured;
 *  - shim-potato's FOUND wins like any complete provider (head-to-head metric);
 *  - shim-potato's MISS is telemetry only — it can never 404 the race;
 *  - shim's fast authoritative miss is untouched (regression guard).
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

	test("host → default four plus a shim-potato tail", () => {
		const roster = raceRoster("https://shim-potato.test");
		expect(roster?.map((p) => p.id)).toEqual([
			"shim",
			"haatz",
			"snap",
			"farcaster-tv",
			"shim-potato",
		]);
		const shimPotato = roster?.at(-1);
		expect(shimPotato?.missAuthoritative).toBe(false);
		// The canonical shim keeps its verdicts — and its fast 404.
		expect(shimProvider.missAuthoritative).toBe(true);
	});
});

describe("shim-potato race semantics", () => {
	test("shim-potato's found wins head-to-head against a slower shim", async () => {
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

	test("shim-potato's miss NEVER 404s — everyone else errors ⇒ unreachable", async () => {
		const race = await raceCast(
			{ username: "zoo", hash: "0xabcdef01" },
			{
				boxMs: 700,
				providers: [
					stub(
						"shim-potato",
						[{ ms: 1, result: { kind: "miss", provider: "shim-potato" } }],
						false,
					),
					stub("shim", [{ ms: 20, result: { kind: "error", provider: "shim", message: "HTTP 500" } }]),
					stub("haatz", [{ ms: 25, result: { kind: "error", provider: "haatz", message: "HTTP 500" } }]),
					stub("snap", [{ ms: 30, result: { kind: "error", provider: "snap", message: "HTTP 500" } }]),
					stub("farcaster-tv", [
						{ ms: 35, result: { kind: "error", provider: "farcaster-tv", message: "HTTP 500" } },
					]),
				],
			},
		);
		expect(race.kind).toBe("unreachable");
		// …but the miss stays visible in telemetry.
		const shimPotatoRow = race.timings.find((t) => t.provider === "shim-potato");
		expect(shimPotatoRow?.kind).toBe("miss");
	});

	test("shim's fast authoritative miss is untouched", async () => {
		const race = await raceCast(
			{ username: "zoo", hash: "0xabcdef01" },
			{
				boxMs: 700,
				providers: [
					stub("shim", [{ ms: 1, result: { kind: "miss", provider: "shim" } }]),
					// Would have found, but shim's verdict lands first —
					// the canary cannot rescue shim's miss (known limit).
					stub("shim-potato", [{ ms: 50, result: found("shim-potato") }]),
				],
			},
		);
		expect(race.kind).toBe("not-found");
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

// The default roster is untouched by the canary: four providers, and the
// module-level shim provider still carries its authoritative verdicts.
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
