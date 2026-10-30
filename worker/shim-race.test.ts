/**
 * Shim race unit tests — cloud vs shim-potato on the raced wrappers.
 *
 * Contract under test (raceShimProbe): the first affirmative answer wins
 * outright; a cloud MISS (HTTP 200, index consulted) is terminal the
 * moment it lands — the potato can never overturn or delay a verdict; a
 * cloud ERROR (non-2xx/throw) defers to a still-pending potato leg before
 * surfacing; potato misses/errors are never authoritative. Without a
 * potatoBase every wrapper is a pass-through (exactly one fetch).
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

describe("cloud verdicts stay terminal", () => {
	test("cloud miss (HTTP 200, no fid) 404s despite a pending potato found", async () => {
		const pendingPotato = deferred<Response>();
		shimMock({
			[fUrl(CLOUD)]: json({ success: false }),
			[fUrl(POTATO)]: pendingPotato.promise,
		});
		// Resolves immediately — it must NOT wait on the potato leg.
		expect(
			await getFidByUsername("ellis", new AbortController().signal, POTATO),
		).toBeUndefined();
		pendingPotato.resolve(json({ success: true, fid: 42 }));
	});

	test("cloud miss beats a pending potato entity (sparse never wins)", async () => {
		const pendingPotato = deferred<Response>();
		const sparse = { fid: 8911, username: null, displayName: null };
		shimMock({
			[userUrl(CLOUD)]: json({ success: true, user: sparse }),
			[userUrl(POTATO)]: pendingPotato.promise,
		});
		const user = await getUserByFid(8911, new AbortController().signal, POTATO);
		// The cloud sparse shape is replayed verbatim — resolveProfile's
		// `username == null` verdict (404) is untouched by the race.
		expect(user).toEqual(sparse);
		pendingPotato.resolve(
			json({ success: true, user: { fid: 8911, username: "ellis" } }),
		);
	});

	test("cloud /wc miss stays authoritative against a potato found", async () => {
		const pendingPotato = deferred<Response>();
		const url = (base: string) => `${base}/wc/ellis/0xabc`;
		shimMock({
			[url(CLOUD)]: json({ success: false }),
			[url(POTATO)]: pendingPotato.promise,
		});
		const lookup = await getCastByUsernameHash(
			"ellis",
			"0xabc",
			new AbortController().signal,
			POTATO,
		);
		expect(lookup.status).toBe("miss");
		pendingPotato.resolve(
			json({ success: true, cast: { fid: 8911, hash: "0xabc" } }),
		);
	});
});

describe("outage surfacing", () => {
	test("cloud 500 + potato 500 ⇒ the cloud error propagates", async () => {
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

	test("cloud throws + potato misses ⇒ the throw still propagates", async () => {
		shimMock({
			[fUrl(CLOUD)]: new Error("network down"),
			[fUrl(POTATO)]: json({ success: false }),
		});
		await expect(
			getFidByUsername("ellis", new AbortController().signal, POTATO),
		).rejects.toThrow("network down");
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
