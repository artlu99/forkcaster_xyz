/**
 * Shim fleet race unit tests — the raced wrappers over the var-defined
 * fleet.
 *
 * Contract under test (raceShimProbe): `potatoBases` IS the fleet — one
 * leg per comma-separated base, in var order (first entry leads at 0ms,
 * later members one stagger step behind; no implicit cloud leg). No
 * single host is the source of truth — the FIRST affirmative (found)
 * answer wins outright; a consulted miss (HTTP 200, index asked) is a
 * vote, with not-found settling only when every leg has missed; errors
 * surface (the PRIMARY — first var entry — leg's) only when every leg
 * errored. Without a value every wrapper is a pass-through to cloud
 * (exactly one fetch — the legacy no-var roster).
 *
 * Mock discipline per profile-route.test.ts: globalThis.fetch routed by
 * exact URL — unexpected URLs throw. Slow legs are deferred promises, so
 * no timers and no abort windows are needed (the stagger's own timers
 * fire naturally inside bun's default test timeout).
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import {
	getCastByUsernameHash,
	getFidByUsername,
	getSignedStatus,
	getUserByFid,
	raceShimProbe,
} from "./shim.ts";

const CLOUD = "https://shim.artlu.xyz";
const POTATO = "https://shim-potato.test";
/** The cutover fleet: potato leads at 0ms, cloud trails one step. */
const FLEET = `${POTATO}, ${CLOUD}`;
/** Cloud-led fleet — keeps the primary leg's legacy error text. */
const CLOUD_FIRST = `${CLOUD}, ${POTATO}`;

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const originalFetch = globalThis.fetch;
let calls: string[] = [];

/** Install a fetch routed by exact URL; values are JSON bodies, Errors throw. */
function shimMock(
	routes: Record<string, Response | Error | Promise<Response>>,
): void {
	calls = [];
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		calls.push(url);
		const route = routes[url];
		if (route === undefined) {
			throw new Error(`Unexpected fetch in test: ${url}`);
		}
		if (route instanceof Error) throw route;
		return route;
	}) as typeof fetch;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const json = (body: unknown) => Response.json(body);
const fUrl = (base: string) => `${base}/f/ellis`;
const userUrl = (base: string) => `${base}/user/8911`;

describe("raceShimProbe routing", () => {
	test("no var: single cloud fetch, no fleet legs", async () => {
		shimMock({ [fUrl(CLOUD)]: json({ success: true, fid: 8911 }) });
		const fid = await getFidByUsername("ellis", new AbortController().signal);
		expect(fid).toBe(8911);
		expect(calls).toEqual([fUrl(CLOUD)]);
	});

	test("a var of just cloud's base: one leg, the member (no special casing)", async () => {
		shimMock({ [fUrl(CLOUD)]: json({ success: true, fid: 8911 }) });
		const fid = await getFidByUsername(
			"ellis",
			new AbortController().signal,
			CLOUD,
		);
		expect(fid).toBe(8911);
		expect(calls).toEqual([fUrl(CLOUD)]);
	});

	test("unexpected URL (e.g. the no-var cloud leg missing from the mock) throws the mock error", async () => {
		shimMock({ [fUrl(POTATO)]: json({ success: true, fid: 42 }) });
		await expect(
			getFidByUsername("ellis", new AbortController().signal),
		).rejects.toThrow("Unexpected fetch in test");
	});
});

describe("fleet members rescue latency and outages", () => {
	test("every member is probed exactly once when the race needs them", async () => {
		// The primary misses fast; the race must wait for the staggered
		// member — both legs fire, once each, and its found wins.
		shimMock({
			[fUrl(POTATO)]: json({ success: false }),
			[fUrl(CLOUD)]: json({ success: true, fid: 8911 }),
		});
		expect(
			await getFidByUsername("ellis", new AbortController().signal, FLEET),
		).toBe(8911);
		// Lexicographic sort puts shim-potato ("-") before shim.artlu (".").
		expect(calls.sort()).toEqual([fUrl(POTATO), fUrl(CLOUD)]);
	});

	test("a fast member's found cancels a straggler's start (the read is saved)", async () => {
		shimMock({
			[fUrl(POTATO)]: json({ success: true, fid: 42 }),
			[fUrl(CLOUD)]: json({ success: true, fid: 8911 }),
		});
		expect(
			await getFidByUsername("ellis", new AbortController().signal, FLEET),
		).toBe(42);
		// The trailing member's stagger timer never fired — no fetch.
		expect(calls).toEqual([fUrl(POTATO)]);
	});
	test("a member's found rescues a hanging primary", async () => {
		const hangCloud = deferred<Response>();
		shimMock({
			[fUrl(CLOUD)]: hangCloud.promise,
			[fUrl(POTATO)]: json({ success: true, fid: 42 }),
		});
		const raced = getFidByUsername(
			"ellis",
			new AbortController().signal,
			CLOUD_FIRST,
		);
		expect(await raced).toBe(42);
		// Both legs fired; the hanging primary is abandoned (drained below).
		expect(calls).toEqual([fUrl(CLOUD), fUrl(POTATO)]);
		hangCloud.resolve(json({ success: true, fid: 8911 }));
	});

	test("first found wins: a fast member beats a slow primary found", async () => {
		const slowCloud = deferred<Response>();
		shimMock({
			[fUrl(CLOUD)]: slowCloud.promise,
			[fUrl(POTATO)]: json({ success: true, fid: 42 }),
		});
		expect(
			await getFidByUsername("ellis", new AbortController().signal, CLOUD_FIRST),
		).toBe(42);
		slowCloud.resolve(json({ success: true, fid: 8911 }));
	});

	test("primary 500 + member found ⇒ rescued (outage does not surface)", async () => {
		shimMock({
			[fUrl(CLOUD)]: new Response("boom", { status: 500 }),
			[fUrl(POTATO)]: json({ success: true, fid: 42 }),
		});
		expect(
			await getFidByUsername("ellis", new AbortController().signal, CLOUD_FIRST),
		).toBe(42);
	});

	test("primary throws + member found ⇒ rescued", async () => {
		shimMock({
			[fUrl(CLOUD)]: new Error("network down"),
			[fUrl(POTATO)]: json({ success: true, fid: 42 }),
		});
		expect(
			await getFidByUsername("ellis", new AbortController().signal, CLOUD_FIRST),
		).toBe(42);
	});
});

describe("collective miss parity — no single host decides", () => {
	test("a pending member's found rescues an already-missed primary", async () => {
		const pendingPotato = deferred<Response>();
		shimMock({
			[fUrl(CLOUD)]: json({ success: false }),
			[fUrl(POTATO)]: pendingPotato.promise,
		});
		const raced = getFidByUsername(
			"ellis",
			new AbortController().signal,
			CLOUD_FIRST,
		);
		// Not settled yet — the primary's miss is a vote, not the verdict.
		let settled = false;
		void raced.then(() => {
			settled = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);
		// The member's found lands and wins.
		pendingPotato.resolve(json({ success: true, fid: 42 }));
		expect(await raced).toBe(42);
	});

	test("consensus: every leg consulted-and-missed ⇒ miss (the 404)", async () => {
		shimMock({
			[fUrl(CLOUD)]: json({ success: false }),
			[fUrl(POTATO)]: json({ success: false }),
		});
		expect(
			await getFidByUsername("ellis", new AbortController().signal, CLOUD_FIRST),
		).toBeUndefined();
	});

	test("a member's found rescues a sparse primary entity (one host's gap is not a verdict)", async () => {
		const sparse = { fid: 8911, username: null, displayName: null };
		shimMock({
			[userUrl(CLOUD)]: json({ success: true, user: sparse }),
			[userUrl(POTATO)]: json({
				success: true,
				user: { fid: 8911, username: "ellis", displayName: "Ellis" },
			}),
		});
		expect(
			await getUserByFid(8911, new AbortController().signal, CLOUD_FIRST),
		).toEqual({ fid: 8911, username: "ellis", displayName: "Ellis" });
	});

	test("all-sparse consensus replays the primary's sparse shape verbatim (404 upstream)", async () => {
		const sparse = { fid: 8911, username: null, displayName: null };
		shimMock({
			[userUrl(CLOUD)]: json({ success: true, user: sparse }),
			[userUrl(POTATO)]: json({ success: true, user: { ...sparse } }),
		});
		const user = await getUserByFid(8911, new AbortController().signal, CLOUD_FIRST);
		expect(user).toEqual(sparse);
	});

	test("primary /wc miss + member found ⇒ the fleet resolves", async () => {
		const url = (base: string) => `${base}/wc/ellis/0xabc`;
		shimMock({
			[url(CLOUD)]: json({ success: false }),
			[url(POTATO)]: json({ success: true, cast: { fid: 8911, hash: "0xabc" } }),
		});
		const lookup = await getCastByUsernameHash(
			"ellis",
			"0xabc",
			new AbortController().signal,
			CLOUD_FIRST,
		);
		expect(lookup.status).toBe("found");
	});
});

describe("fleet surfacing", () => {
	test("primary throws + member misses ⇒ consulted miss wins over errors (404)", async () => {
		shimMock({
			[fUrl(CLOUD)]: new Error("network down"),
			[fUrl(POTATO)]: json({ success: false }),
		});
		// The network was asked (by the member) — a 404 verdict, not a 503.
		expect(
			await getFidByUsername("ellis", new AbortController().signal, CLOUD_FIRST),
		).toBeUndefined();
	});

	test("three-member fleet: first found wins, a hung leg can't block", async () => {
		const hang = deferred<Response>();
		const P2 = "https://shim-potato-2.test";
		shimMock({
			[fUrl(CLOUD)]: hang.promise,
			[fUrl(POTATO)]: json({ success: false }),
			[`${P2}/f/ellis`]: json({ success: true, fid: 7 }),
		});
		expect(
			await getFidByUsername(
				"ellis",
				new AbortController().signal,
				`${POTATO}, ${P2}, ${CLOUD}`,
			),
		).toBe(7);
		hang.resolve(json({ success: true, fid: 8911 }));
	});

	test("all legs error ⇒ the PRIMARY leg's error propagates", async () => {
		shimMock({
			[fUrl(CLOUD)]: new Response("boom", { status: 500 }),
			[fUrl(POTATO)]: new Response("boom", { status: 500 }),
		});
		await expect(
			getFidByUsername("ellis", new AbortController().signal, CLOUD_FIRST),
		).rejects.toThrow("shim /f HTTP 500");
	});

	test("the primary is the first VAR entry — var order decides whose error surfaces", async () => {
		shimMock({
			[fUrl(CLOUD)]: new Response("boom", { status: 500 }),
			[fUrl(POTATO)]: new Error("potato down"),
		});
		await expect(
			getFidByUsername("ellis", new AbortController().signal, FLEET),
		).rejects.toThrow("potato down");
	});
});

describe("endpoint-specific racing", () => {
	test("getSignedStatus: member boolean rescues a 500 primary (fails open to data)", async () => {
		const url = (base: string) => `${base}/signed/8911`;
		shimMock({
			[url(CLOUD)]: new Response("boom", { status: 500 }),
			[url(POTATO)]: json({ signed: false }),
		});
		expect(
			await getSignedStatus(8911, new AbortController().signal, CLOUD_FIRST),
		).toBe(false);
	});

	test("getUserByFid: a non-sparse member entity rescues a hanging primary", async () => {
		const hangCloud = deferred<Response>();
		const potatoUser = { fid: 8911, username: "ellis", displayName: "Ellis" };
		shimMock({
			[userUrl(CLOUD)]: hangCloud.promise,
			[userUrl(POTATO)]: json({ success: true, user: potatoUser }),
		});
		expect(
			await getUserByFid(8911, new AbortController().signal, CLOUD_FIRST),
		).toEqual(potatoUser);
		hangCloud.resolve(json({ success: true, user: potatoUser }));
	});

	test("raceShimProbe: the probe runs per var base with its own terminal", async () => {
		shimMock({
			[fUrl(CLOUD)]: json({ success: true, fid: 8911 }),
			[fUrl(POTATO)]: json({ success: true, fid: 42 }),
		});
		const probe = async (base: string) => {
			const res = await fetch(`${base}/f/ellis`, {
				signal: new AbortController().signal,
			});
			const data = (await res.json()) as { fid?: number };
			return typeof data.fid === "number"
				? ({ kind: "found", value: data.fid } as const)
				: ({ kind: "miss", fallback: undefined } as const);
		};
		// First found wins (insertion order is not the contract — the found
		// promise resolution is), and its verdict stands.
		const result = await raceShimProbe(probe, FLEET);
		expect(result.kind).toBe("found");
		if (result.kind === "found") {
			expect([42, 8911]).toContain(result.value);
		}
	});
});
