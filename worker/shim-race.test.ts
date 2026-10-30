/**
 * Shim fleet race unit tests — cloud vs the shim-potato fleet on the raced
 * wrappers.
 *
 * Contract under test (raceShimProbe): no single host is the source of
 * truth — the FIRST affirmative answer wins outright; a consulted miss
 * (HTTP 200, index asked) is a vote, with not-found settling only when
 * every leg has missed; errors surface (cloud's, for legacy message
 * stability) only when every leg errored. Without a potatoBases value
 * every wrapper is a pass-through (exactly one fetch).
 *
 * Mock discipline per profile-route.test.ts: globalThis.fetch routed by
 * exact URL — unexpected URLs throw. Slow legs are deferred promises, so
 * no timers and no abort windows are needed.
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
	test("no potatoBase: single cloud fetch, potato never called", async () => {
		shimMock({ [fUrl(CLOUD)]: json({ success: true, fid: 8911 }) });
		const fid = await getFidByUsername("ellis", new AbortController().signal);
		expect(fid).toBe(8911);
		expect(calls).toEqual([fUrl(CLOUD)]);
	});

	test("potatoBase === cloud base: still a single leg", async () => {
		shimMock({ [fUrl(CLOUD)]: json({ success: true, fid: 8911 }) });
		const fid = await getFidByUsername(
			"ellis",
			new AbortController().signal,
			CLOUD,
		);
		expect(fid).toBe(8911);
		expect(calls).toEqual([fUrl(CLOUD)]);
	});

	test("unexpected URL (e.g. potato without base) throws the mock error", async () => {
		shimMock({ [fUrl(POTATO)]: json({ success: true, fid: 42 }) });
		await expect(
			getFidByUsername("ellis", new AbortController().signal),
		).rejects.toThrow("Unexpected fetch in test");
	});
});

describe("potato rescues latency and outages", () => {
	test("potato found rescues a hanging cloud leg", async () => {
		const hangCloud = deferred<Response>();
		shimMock({
			[fUrl(CLOUD)]: hangCloud.promise,
			[fUrl(POTATO)]: json({ success: true, fid: 42 }),
		});
		const raced = getFidByUsername("ellis", new AbortController().signal, POTATO);
		expect(await raced).toBe(42);
		// Both legs fired; the cloud leg is abandoned pending (drained below).
		expect(calls).toEqual([fUrl(CLOUD), fUrl(POTATO)]);
		hangCloud.resolve(json({ success: true, fid: 8911 }));
	});

	test("first found wins: a fast potato beats a slow cloud found", async () => {
		const slowCloud = deferred<Response>();
		shimMock({
			[fUrl(CLOUD)]: slowCloud.promise,
			[fUrl(POTATO)]: json({ success: true, fid: 42 }),
		});
		expect(
			await getFidByUsername("ellis", new AbortController().signal, POTATO),
		).toBe(42);
		slowCloud.resolve(json({ success: true, fid: 8911 }));
	});

	test("cloud 500 + potato found ⇒ rescued (outage does not surface)", async () => {
		shimMock({
			[fUrl(CLOUD)]: new Response("boom", { status: 500 }),
			[fUrl(POTATO)]: json({ success: true, fid: 42 }),
		});
		expect(
			await getFidByUsername("ellis", new AbortController().signal, POTATO),
		).toBe(42);
	});

	test("cloud throws + potato found ⇒ rescued", async () => {
		shimMock({
			[fUrl(CLOUD)]: new Error("network down"),
			[fUrl(POTATO)]: json({ success: true, fid: 42 }),
		});
		expect(
			await getFidByUsername("ellis", new AbortController().signal, POTATO),
		).toBe(42);
	});
});

describe("collective miss parity — no single host decides", () => {
	test("a pending potato found rescues an already-missed cloud leg", async () => {
		const pendingPotato = deferred<Response>();
		shimMock({
			[fUrl(CLOUD)]: json({ success: false }),
			[fUrl(POTATO)]: pendingPotato.promise,
		});
		const raced = getFidByUsername("ellis", new AbortController().signal, POTATO);
		// Not settled yet — the cloud miss is a vote, not the verdict.
		let settled = false;
		void raced.then(() => {
			settled = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(settled).toBe(false);
		// The potato's found lands and wins.
		pendingPotato.resolve(json({ success: true, fid: 42 }));
		expect(await raced).toBe(42);
	});

	test("consensus: every leg consulted-and-missed ⇒ miss (the 404)", async () => {
		shimMock({
			[fUrl(CLOUD)]: json({ success: false }),
			[fUrl(POTATO)]: json({ success: false }),
		});
		expect(
			await getFidByUsername("ellis", new AbortController().signal, POTATO),
		).toBeUndefined();
	});

	test("a potato found rescues a sparse cloud entity (cloud's gap is not a verdict)", async () => {
		const sparse = { fid: 8911, username: null, displayName: null };
		shimMock({
			[userUrl(CLOUD)]: json({ success: true, user: sparse }),
			[userUrl(POTATO)]: json({
				success: true,
				user: { fid: 8911, username: "ellis", displayName: "Ellis" },
			}),
		});
		expect(
			await getUserByFid(8911, new AbortController().signal, POTATO),
		).toEqual({ fid: 8911, username: "ellis", displayName: "Ellis" });
	});

	test("all-sparse consensus replays cloud's sparse shape verbatim (404 upstream)", async () => {
		const sparse = { fid: 8911, username: null, displayName: null };
		shimMock({
			[userUrl(CLOUD)]: json({ success: true, user: sparse }),
			[userUrl(POTATO)]: json({ success: true, user: { ...sparse } }),
		});
		const user = await getUserByFid(8911, new AbortController().signal, POTATO);
		expect(user).toEqual(sparse);
	});

	test("cloud /wc miss + potato found ⇒ the fleet resolves", async () => {
		const url = (base: string) => `${base}/wc/ellis/0xabc`;
		shimMock({
			[url(CLOUD)]: json({ success: false }),
			[url(POTATO)]: json({ success: true, cast: { fid: 8911, hash: "0xabc" } }),
		});
		const lookup = await getCastByUsernameHash(
			"ellis",
			"0xabc",
			new AbortController().signal,
			POTATO,
		);
		expect(lookup.status).toBe("found");
	});
});

describe("fleet surfacing", () => {
	test("cloud throws + potato misses ⇒ consulted miss wins over errors (404)", async () => {
		shimMock({
			[fUrl(CLOUD)]: new Error("network down"),
			[fUrl(POTATO)]: json({ success: false }),
		});
		// The network was asked (by the potato) — a 404 verdict, not a 503.
		expect(
			await getFidByUsername("ellis", new AbortController().signal, POTATO),
		).toBeUndefined();
	});

	test("three-leg fleet: first found wins, a hung leg can't block", async () => {
		const hang = deferred<Response>();
		const P2 = "https://shim-potato-2.test";
		shimMock({
			[fUrl(CLOUD)]: hang.promise,
			[fUrl(POTATO)]: json({ success: false }),
			[`${P2}/f/ellis`]: json({ success: true, fid: 7 }),
		});
		expect(
			await getFidByUsername("ellis", new AbortController().signal, `${POTATO}, ${P2}`),
		).toBe(7);
		hang.resolve(json({ success: true, fid: 8911 }));
	});

	test("all legs error ⇒ the cloud error propagates", async () => {
		shimMock({
			[fUrl(CLOUD)]: new Response("boom", { status: 500 }),
			[fUrl(POTATO)]: new Response("boom", { status: 500 }),
		});
		await expect(
			getFidByUsername("ellis", new AbortController().signal, POTATO),
		).rejects.toThrow("shim /f HTTP 500");
	});

	test("cloud 500 + potato error ⇒ still the cloud error", async () => {
		shimMock({
			[fUrl(CLOUD)]: new Response("boom", { status: 500 }),
			[fUrl(POTATO)]: new Error("potato down"),
		});
		await expect(
			getFidByUsername("ellis", new AbortController().signal, POTATO),
		).rejects.toThrow("shim /f HTTP 500");
	});
});

describe("endpoint-specific racing", () => {
	test("getSignedStatus: potato boolean rescues a 500 cloud (fails open to data)", async () => {
		const url = (base: string) => `${base}/signed/8911`;
		shimMock({
			[url(CLOUD)]: new Response("boom", { status: 500 }),
			[url(POTATO)]: json({ signed: false }),
		});
		expect(
			await getSignedStatus(8911, new AbortController().signal, POTATO),
		).toBe(false);
	});

	test("getUserByFid: a non-sparse potato entity rescues a hanging cloud", async () => {
		const hangCloud = deferred<Response>();
		const potatoUser = { fid: 8911, username: "ellis", displayName: "Ellis" };
		shimMock({
			[userUrl(CLOUD)]: hangCloud.promise,
			[userUrl(POTATO)]: json({ success: true, user: potatoUser }),
		});
		expect(
			await getUserByFid(8911, new AbortController().signal, POTATO),
		).toEqual(potatoUser);
		hangCloud.resolve(json({ success: true, user: potatoUser }));
	});

	test("raceShimProbe: the probe runs per base with its own terminal", async () => {
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
		// Cloud answered found first (insertion order is not the contract —
		// the found promise resolution is), and its verdict stands.
		const result = await raceShimProbe(probe, POTATO);
		expect(result.kind).toBe("found");
		if (result.kind === "found") {
			expect([42, 8911]).toContain(result.value);
		}
	});
});
