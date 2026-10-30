/**
 * Shell-cache integration tests — the invariant gate at the cast route:
 * only personalization-free requests may read/fill the shell; only
 * found-complete renders enter it; a hit serves bytes identical to the
 * fill without touching upstream again; cookie-holders and misses keep
 * today's exact pass-through behavior.
 *
 * Same contract as cast-route.test.ts: globalThis.fetch routed by exact
 * URL (unexpected URLs throw — non-shim race legs error out and shim
 * wins). The Workers Cache API is mocked with an in-memory store; without
 * the mock the route's guarded get/put are no-ops, which is why the rest
 * of the suite never notices the cache.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));
// CJS deps (linkify-react) call require("react"); sync preact/compat works.
mock.module("react", () => require("preact/compat"));
mock.module("react-dom", () => require("preact/compat"));
mock.module("react/jsx-runtime", () => require("preact/jsx-runtime"));
mock.module("react/jsx-dev-runtime", () => require("preact/jsx-runtime"));

const { app } = await import("./index.ts");

const HASH = "0x9be1cc77";
const CAST = {
	fid: 10215,
	hash: "0x9be1cc77aa11bb22cc33dd44ee55ff66aa77bb88",
	text: "shell cache fixture",
	timestamp: 1_700_000_000,
	embeds: [],
	user: { fid: 10215, username: "zoo", fname: "zoo", displayName: "zoo" },
};

const originalFetch = globalThis.fetch;
let upstreamCalls = 0;
const store = new Map<string, Response>();

beforeEach(() => {
	upstreamCalls = 0;
	store.clear();
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		upstreamCalls += 1;
		const url = String(input);
		if (url === `https://shim.artlu.xyz/wc/zoo/${HASH}`) {
			return Response.json({ success: true, cast: CAST });
		}
		if (url === "https://shim.artlu.xyz/wc/zoo/0xdeadbeef") {
			return Response.json({ success: false, error: "cast not found" });
		}
		if (url === "https://shim.artlu.xyz/signed/10215") {
			return Response.json({ success: true, signed: true });
		}
		throw new Error(`Unexpected fetch in test: ${url}`);
	}) as typeof fetch;
	(globalThis as unknown as { caches?: unknown }).caches = {
		default: {
			match: async (key: Request | string) =>
				store.get(typeof key === "string" ? key : key.url),
			put: async (key: Request, response: Response) => {
				store.set(key.url, response.clone());
			},
		},
	};
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	delete (globalThis as unknown as { caches?: unknown }).caches;
});

test("fill then hit: the second cookie-less render never touches upstream", async () => {
	const first = await app.request(`/zoo/${HASH}`);
	expect(first.status).toBe(200);
	expect(first.headers.get("x-forkcaster-shell")).toBe("fill");
	expect(store.size).toBe(1);
	const fillCalls = upstreamCalls;
	const fillBody = await first.text();

	const second = await app.request(`/zoo/${HASH}`);
	expect(second.status).toBe(200);
	expect(second.headers.get("x-forkcaster-shell")).toBe("hit");
	// Zero upstream reads on a hit — the paint came from the edge.
	expect(upstreamCalls).toBe(fillCalls);
	// A hit is byte-identical to the fill (the preview invariant).
	expect(await second.text()).toBe(fillBody);
	// Browsers pass every click through; the edge owns the caching.
	expect(second.headers.get("cache-control")).toBe("no-store");
});

test("cookie-holders bypass the shell entirely", async () => {
	await app.request(`/zoo/${HASH}`);
	const callsAfterFill = upstreamCalls;
	const personal = await app.request(`/zoo/${HASH}`, {
		headers: { cookie: "fc_client=zoo" },
	});
	expect(personal.status).toBe(200);
	expect(personal.headers.get("x-forkcaster-shell")).toBeNull();
	expect(upstreamCalls).toBeGreaterThan(callsAfterFill);
});

test("noredirect asks pass through uncached", async () => {
	const res = await app.request(`/zoo/${HASH}?noredirect=1`);
	expect(res.status).toBe(200);
	expect(res.headers.get("x-forkcaster-shell")).toBeNull();
	expect(store.size).toBe(0);
});

test("misses never cache: a consensus 404 leaves the store empty", async () => {
	const res = await app.request("/zoo/0xdeadbeef");
	expect(res.status).toBe(404);
	expect(res.headers.get("x-forkcaster-shell")).toBeNull();
	const again = await app.request("/zoo/0xdeadbeef");
	expect(again.status).toBe(404);
	expect(store.size).toBe(0);
});
