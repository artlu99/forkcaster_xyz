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
