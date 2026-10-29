/**
 * /transparency + /race-stats.json route behavior: edge-cache headers on
 * the rendered responses, JSON negotiation (query wins over Accept), and
 * the 404 contract of the raw snapshot. `caches` is undefined under bun
 * test, so every test here exercises the render paths (never a cache
 * hit) — the header is what the edge would key the put() TTL off.
 */
import { expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));
// CJS deps (linkify-react) call require("react"); sync preact/compat works.
mock.module("react", () => require("preact/compat"));
mock.module("react-dom", () => require("preact/compat"));
mock.module("react/jsx-runtime", () => require("preact/jsx-runtime"));
mock.module("react/jsx-dev-runtime", () => require("preact/jsx-runtime"));

const { app } = await import("./index.ts");

test("HTML carries the edge-cache header and renders the page", async () => {
	const res = await app.request("/transparency", undefined, {});
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toContain("text/html");
	expect(res.headers.get("cache-control")).toBe("public, s-maxage=60");
	const html = await res.text();
	expect(html).toContain("transparency");
});

test("?format=json serves the JSON twin with the same edge-cache header", async () => {
	const res = await app.request("/transparency?format=json", undefined, {});
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toContain("application/json");
	expect(res.headers.get("cache-control")).toBe("public, s-maxage=60");
	const body = (await res.json()) as Record<string, unknown>;
	expect(body).toHaveProperty("racingStats");
	expect(body).toHaveProperty("clientRank");
	expect(body).toHaveProperty("fidRace");
});

test("Accept-only JSON negotiates JSON under the bare URL (cache-bypassed variant)", async () => {
	const res = await app.request("/transparency", {
		headers: { Accept: "application/json" },
	});
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toContain("application/json");
});

test("/race-stats.json: no snapshot → 404 without a cache header", async () => {
	// No lmdis env in the test runner ⇒ the store resolves null ⇒ the miss
	// must stay a bare 404 (never edge-cached).
	const miss = await app.request("/race-stats.json", undefined, {});
	expect(miss.status).toBe(404);
	expect(miss.headers.get("cache-control")).toBeNull();
});
