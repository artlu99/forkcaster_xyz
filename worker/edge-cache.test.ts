/**
 * edge-cache unit tests — the shell gate's pure predicates and the key.
 * The invariant under test: only a found, complete render is worth
 * caching; only personalization-free requests participate; the key is
 * salted and query-free.
 */
import { describe, expect, test } from "bun:test";

import {
	SHELL_SALT,
	shellCacheKey,
	shellRequestEligible,
	shellWorthCaching,
} from "./edge-cache.ts";

describe("shellRequestEligible", () => {
	test("a cookie-free HTML request is eligible", () => {
		expect(
			shellRequestEligible({ cookiePresent: false, noredirect: false, wantsJson: false }),
		).toBe(true);
	});

	test("a cookie (fc_client) makes the render personal — never cached", () => {
		expect(
			shellRequestEligible({ cookiePresent: true, noredirect: false, wantsJson: false }),
		).toBe(false);
	});

	test("noredirect and JSON asks pass through", () => {
		expect(
			shellRequestEligible({ cookiePresent: false, noredirect: true, wantsJson: false }),
		).toBe(false);
		expect(
			shellRequestEligible({ cookiePresent: false, noredirect: false, wantsJson: true }),
		).toBe(false);
	});
});

describe("shellWorthCaching", () => {
	test("a found, complete 200 is the one cacheable outcome", () => {
		expect(
			shellWorthCaching({ status: 200, kind: "found", partial: false }),
		).toBe(true);
	});

	test("partials, misses, outages and non-200s never enter", () => {
		expect(
			shellWorthCaching({ status: 200, kind: "found", partial: true }),
		).toBe(false);
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
