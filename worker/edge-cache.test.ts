/**
 * edge-cache unit tests — the shell gate's pure predicates and the key.
 * The invariant under test: only a found render with canonical body text
 * is worth caching; only personalization-free requests participate; the
 * key is salted and query-free.
 */
import { describe, expect, test } from "bun:test";

import {
	PROFILE_SHELL_TTL_SECONDS,
	SHELL_SALT,
	SHELL_TTL_SECONDS,
	putShell,
	shellCacheKey,
	shellRequestEligible,
	shellWorthCaching,
} from "./edge-cache.ts";

describe("shell TTLs", () => {
	test("profile-family shells share the cast TTL — scraper repeats must not re-fill through shim every 10 min", () => {
		expect(PROFILE_SHELL_TTL_SECONDS).toBe(SHELL_TTL_SECONDS);
		expect(PROFILE_SHELL_TTL_SECONDS).toBe(43_200);
	});
});

describe("putShell", () => {
	test("the stored copy drops the CDN directive — layer 2 is governed by ttlSeconds alone", async () => {
		const stored = new Map<string, Response>();
		(globalThis as unknown as { caches?: unknown }).caches = {
			default: {
				match: async () => undefined,
				put: async (key: Request, response: Response) => {
					stored.set(key.url, response);
				},
			},
		};
		try {
			const key = new Request("https://forkcaster.xyz/decent-artlu?shell=v11");
			const response = new Response("<html></html>", {
				headers: {
					"content-type": "text/html; charset=utf-8",
					// What the route sets on the visitor copy for the zone
					// Cache Rule — must not ride into the layer-2 store.
					"cdn-cache-control": `public, s-maxage=${PROFILE_SHELL_TTL_SECONDS}`,
				},
			});
			await putShell(key, response, 60);
			const hit = stored.get(key.url);
			expect(hit).toBeDefined();
			expect(hit!.headers.get("cache-control")).toBe("public, s-maxage=60");
			expect(hit!.headers.get("cdn-cache-control")).toBeNull();
		} finally {
			delete (globalThis as unknown as { caches?: unknown }).caches;
		}
	});
});

describe("shellRequestEligible", () => {
	test("an HTML request is eligible — cookie-holders included (personalization is client-side)", () => {
		expect(shellRequestEligible({ wantsJson: false })).toBe(true);
	});

	test("JSON asks bypass entirely", () => {
		expect(shellRequestEligible({ wantsJson: true })).toBe(false);
	});
});

describe("shellWorthCaching", () => {
	test("a found, complete 200 is the one cacheable outcome", () => {
		expect(
			shellWorthCaching({ status: 200, kind: "found", partial: false }),
		).toBe(true);
		expect(
			// Partials self-heal client-side (QUOTE_FILL_SCRIPT re-fetches the
			// fresh no-store fragment per view) and their meta is complete —
			// cacheable (Oct 2026 gate extension).
			shellWorthCaching({ status: 200, kind: "found", partial: true }),
		).toBe(true);
	});

	test("a text-blind found never enters — a body can't self-heal", () => {
		// Mention-stripped raw-node wins: lossy body text, QUOTE_FILL
		// withheld (their quotes are already inline). Fresh every time.
		expect(
			shellWorthCaching({
				status: 200,
				kind: "found",
				partial: true,
				textCanonical: false,
			}),
		).toBe(false);
		// Canonical text stays cacheable regardless of the partial flag.
		expect(
			shellWorthCaching({
				status: 200,
				kind: "found",
				partial: true,
				textCanonical: true,
			}),
		).toBe(true);
		// The profile family (shim-only) omits the flag — canonical.
		expect(
			shellWorthCaching({ status: 200, kind: "found", partial: false }),
		).toBe(true);
	});

	test("misses, outages and non-200s never enter", () => {
		expect(
			shellWorthCaching({ status: 404, kind: "not-found", partial: false }),
		).toBe(false);
		expect(
			shellWorthCaching({ status: 503, kind: "unreachable", partial: false }),
		).toBe(false);
		expect(
			shellWorthCaching({ status: 200, kind: "unreachable", partial: false }),
		).toBe(false);
	});
});

describe("shellCacheKey", () => {
	test("query-free and salted: shared-link parameters never fork keys", () => {
		const plain = shellCacheKey(new URL("https://forkcaster.xyz/zoo/0xabc"));
		const tracked = shellCacheKey(
			new URL("https://forkcaster.xyz/zoo/0xabc?fbclid=123&format=json"),
		);
		expect(plain.url).toBe(`https://forkcaster.xyz/zoo/0xabc?shell=${SHELL_SALT}`);
		expect(tracked.url).toBe(plain.url);
	});

	test("hosts stay separate keys (dual-serve)", () => {
		const a = shellCacheKey(new URL("https://forkcaster.xyz/zoo/0xabc"));
		const b = shellCacheKey(new URL("https://warpcats.com/zoo/0xabc"));
		expect(a.url).not.toBe(b.url);
	});
});
