/**
 * Cast-data unit tests: the internal/external link gate — URL
 * classification, host matching, and the embed bucketing the client
 * eligibility flow consumes. Pure module: no fetch mocks needed.
 */
import { describe, expect, test } from "bun:test";

import type { ShimCast } from "./shim.ts";
import {
	classifyUrl,
	externalUrlEmbedsOf,
	hasExternalLinks,
	toOgDescription,
} from "./cast-data.ts";

const FULL = `0x${"ab".repeat(20)}`;
const QUOTE_HASH = `0x${"cd".repeat(20)}`;

describe("classifyUrl", () => {
	test("core hosts are internal, in every spelling", () => {
		for (const url of [
			"https://farcaster.xyz/zoo/0x895ecc74",
			"https://www.farcaster.xyz/zoo/0x895ecc74",
			"https://a.b.farcaster.xyz/",
			"http://farcaster.xyz/", // scheme-agnostic
			"https://FARCASTER.XYZ/", // case-insensitive
			"https://farcaster.xyz./path", // trailing-dot FQDN
			"https://warpcast.com/zoo/0x895ecc74", // legacy host
			"https://www.warpcast.com/",
			"https://forkcaster.xyz/zoo/0x895ecc74",
			"https://warpcats.com/zoo/0x895ecc74",
		]) {
			expect(classifyUrl(url)).toBe("internal");
		}
	});

	test("registry client hosts are internal (derived, www-stripped)", () => {
		for (const url of [
			`https://firefly.social/post/farcaster/${FULL}`,
			`https://quilcast.com/c/${FULL.slice(2)}`,
			`https://explorer.neynar.com/${FULL}`,
			"https://vibeshift.onchain.cooking/?view=cast",
			"https://quorummessenger.com/",
			"https://www.quorummessenger.com/",
			"https://sub.explorer.neynar.com/", // subdomains of a known host
		]) {
			expect(classifyUrl(url)).toBe("internal");
		}
	});

	test("lookalikes and strangers stay external", () => {
		for (const url of [
			"https://evil-quilcast.com/", // hyphen lookalike — the leading-dot rule
			"https://notfirefly.social/",
			"https://xfarcaster.xyz/", // prefix lookalike
			"https://quilcast.com.evil.test/", // suffix spoof
			"https://example.com/farcaster.xyz", // the host decides, not the path
			"https://x.com/henry58290/status/2113679793317384355",
		]) {
			expect(classifyUrl(url)).toBe("external");
		}
	});

	test("unparseable and non-web URLs fail open as external", () => {
		for (const url of [
			"",
			"not a url",
			"//example.com/path", // scheme-relative, no base
			"javascript:alert(1)",
			"mailto:a@b.c",
			"ftp://x.test/f",
		]) {
			expect(classifyUrl(url)).toBe("external");
		}
	});

	test("the optional scope narrows the internal set (default: all)", () => {
		const hosts = ["farcaster.xyz"];
		expect(classifyUrl("https://farcaster.xyz/zoo/0x895ecc74", hosts)).toBe(
			"internal",
		);
		expect(classifyUrl("https://www.farcaster.xyz/", hosts)).toBe("internal");
		expect(classifyUrl("https://firefly.social/", hosts)).toBe("external");
	});
});

describe("externalUrlEmbedsOf / hasExternalLinks", () => {
	const cast = (embeds: ShimCast["embeds"]): ShimCast => ({
		hash: FULL,
		embeds,
	});

	test("keeps only external URL embeds: deduped, ordered, uncapped", () => {
		const urls = externalUrlEmbedsOf(
			cast([
				{ url: "https://x.com/a/status/1" },
				{ url: "https://farcaster.xyz/zoo/0x895ecc74" }, // internal
				{ castId: { fid: 3854, hash: QUOTE_HASH } }, // quote
				{ url: "https://x.com/a/status/1" }, // duplicate
				{ url: "https://imagedelivery.net/abc/original" }, // image host
				{ url: "https://example.com/a.png" }, // image extension
				{ url: "" }, // empty — not a link
				{ url: "https://example.com/1" },
				{ url: "https://example.com/2" },
				{ url: "https://example.com/3" },
				{ url: "https://example.com/4" }, // 4th external: the gate is uncapped
			]),
		);
		expect(urls).toEqual([
			"https://x.com/a/status/1",
			"https://example.com/1",
			"https://example.com/2",
			"https://example.com/3",
			"https://example.com/4",
		]);
	});

	test("no external links ⇒ false: internal-only, images-only, quotes-only, none", () => {
		expect(
			hasExternalLinks(cast([{ url: "https://farcaster.xyz/zoo/0x895ecc74" }])),
		).toBe(false);
		expect(
			hasExternalLinks(cast([{ url: "https://imagedelivery.net/abc/original" }])),
		).toBe(false);
		expect(
			hasExternalLinks(cast([{ castId: { fid: 1, hash: QUOTE_HASH } }])),
		).toBe(false);
		expect(hasExternalLinks(cast(undefined))).toBe(false);
	});

	test("any external link ⇒ true (the pill-eligibility signal)", () => {
		expect(
			hasExternalLinks(cast([{ url: "https://basescan.org/tx/0xbed8" }])),
		).toBe(true);
	});
});

describe("toOgDescription", () => {
	const quoted = {
		hash: QUOTE_HASH,
		text: "the original take",
		user: { username: "quoteduser", fname: "quoted" },
	};

	test("quote-less casts keep the plain description", () => {
		expect(toOgDescription("hello", [])).toBe("hello");
		// Unhydrated entries contribute nothing.
		expect(toOgDescription("hello", [undefined])).toBe("hello");
		expect(toOgDescription(undefined, [])).toBeUndefined();
	});

	test("hydrated quotes ride in as ↷ lines with the primary handle", () => {
		expect(toOgDescription("parent text", [quoted])).toBe(
			"parent text\n↷ @quoted: the original take",
		);
	});

	test("quotes without a resolvable handle are skipped, not guessed", () => {
		expect(
			toOgDescription("parent text", [{ ...quoted, user: undefined }]),
		).toBe("parent text");
	});

	test("a quote line shrinks the parent budget to 200", () => {
		const out = toOgDescription("x".repeat(400), [quoted]) ?? "";
		const [parent, line] = out.split("\n");
		expect(parent?.startsWith("x")).toBe(true);
		expect(parent?.endsWith("…")).toBe(true);
		expect(parent).toHaveLength(200);
		expect(line).toBe("↷ @quoted: the original take");
	});

	test("no parent text renders the quote line alone", () => {
		expect(toOgDescription(undefined, [quoted])).toBe(
			"↷ @quoted: the original take",
		);
	});

	test("at most two quote lines", () => {
		const out = toOgDescription("p", [quoted, quoted, quoted]) ?? "";
		expect(out.split("\n")).toHaveLength(3);
	});
});
