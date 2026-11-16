/**
 * Cast-data unit tests: the internal/external link gate — URL
 * classification, host matching, and the embed bucketing the client
 * eligibility flow consumes. Pure module: no fetch mocks needed.
 */
import { describe, expect, test } from "bun:test";

import type { ShimCast } from "./shim.ts";
import {
	classifyUrl,
	displayNameOf,
	externalUrlEmbedsOf,
	hasExternalLinks,
	toOgDescription,
} from "./cast-data.ts";

const FULL = `0x${"ab".repeat(20)}`;
const QUOTE_HASH = `0x${"cd".repeat(20)}`;

describe("displayNameOf — the display waterfall", () => {
	test("displayName → username → fname", () => {
		expect(displayNameOf({ displayName: "mvr 🦊", username: "mvr", fname: "mvr" })).toBe(
			"mvr 🦊",
		);
		expect(
			displayNameOf({ displayName: null, username: "nikolaii.eth", fname: "nikolaiii" }),
		).toBe("nikolaii.eth");
		expect(displayNameOf({ displayName: null, username: null, fname: "nikolaiii" })).toBe(
			"nikolaiii",
		);
	});

	test("empty/whitespace displayName falls through; nothing at all is empty", () => {
		expect(displayNameOf({ displayName: "   ", username: "mvr", fname: "mvr" })).toBe(
			"mvr",
		);
		expect(displayNameOf({ displayName: "", username: "", fname: "" })).toBe("");
		expect(displayNameOf(undefined)).toBe("");
	});
});

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

	test("hydrated quotes ride in as > lines with the primary handle", () => {
		expect(toOgDescription("parent text", [quoted])).toBe(
			"parent text\n\n> @quoted: the original take",
		);
	});

	test("quotes without a resolvable handle are skipped, not guessed", () => {
		expect(
			toOgDescription("parent text", [{ ...quoted, user: undefined }]),
		).toBe("parent text");
	});

	test("a quote line shrinks the parent budget to 200", () => {
		const out = toOgDescription("x".repeat(400), [quoted]) ?? "";
		const [parent, line] = out.split("\n\n");
		expect(parent?.startsWith("x")).toBe(true);
		expect(parent?.endsWith("…")).toBe(true);
		expect(parent).toHaveLength(200);
		expect(line).toBe("> @quoted: the original take");
	});

	test("no parent text renders the quote line alone", () => {
		expect(toOgDescription(undefined, [quoted])).toBe(
			"> @quoted: the original take",
		);
	});

	test("at most two quote lines", () => {
		const out = toOgDescription("p", [quoted, quoted, quoted]) ?? "";
		const [, block] = out.split("\n\n");
		expect(block.split("\n")).toHaveLength(2);
	});
});

// --- Farcaster Articles (cast chains) -----------------------------------------

import {
	articleChainOf,
	articleCoverOf,
	articleHeadOf,
	articleOpeningPlain,
	articleHeadViewOf,
	isArticleHead,
	isArticlePart,
} from "./cast-data.ts";

const HEAD: ShimCast = {
	fid: 4167,
	hash: `0x${"aa".repeat(20)}`,
	text: "My Article\n\nThe opening line, with **bold** and a [link](https://example.com/x).",
	embeds: [{ url: "https://imagedelivery.net/BXlu/cover/original" }],
	timestamp: 1_792_000_000,
	formatVersion: 1,
	chain: { index: 0, count: 3 },
	user: { fid: 4167, username: "nounishprof", displayName: "Nounish Prof" },
};
const PART: ShimCast = {
	...HEAD,
	hash: `0x${"bb".repeat(20)}`,
	text: "The body's second part.",
	embeds: [],
	chain: { root: { fid: 4167, hash: HEAD.hash ?? "" }, index: 1, count: 3 },
};

describe("articleChainOf — the FIP's chain rules, re-checked", () => {
	test("a valid head has index 0 and no root; a valid part has the author's root", () => {
		expect(articleChainOf(HEAD)).toEqual({ index: 0, count: 3 });
		expect(articleChainOf(PART)).toEqual({
			root: { fid: 4167, hash: HEAD.hash },
			index: 1,
			count: 3,
		});
	});

	test("protobuf's omitted zeros read as 0", () => {
		expect(articleChainOf({ ...HEAD, chain: {} })).toEqual({
			index: 0,
			count: 0,
		});
	});

	test("a root at index 0 is rejected", () => {
		expect(
			articleChainOf({ ...HEAD, chain: { index: 0, count: 2, root: { fid: 4167, hash: "0xbb" } } }),
		).toBeUndefined();
	});

	test("a root owned by someone else is rejected; no root at all is rejected", () => {
		expect(
			articleChainOf({
				...PART,
				chain: { root: { fid: 99, hash: HEAD.hash ?? "" }, index: 1, count: 2 },
			}),
		).toBeUndefined();
		expect(articleChainOf({ ...PART, chain: { index: 1, count: 2 } })).toBeUndefined();
	});

	test("out-of-range shapes are rejected: index ≥ count, ≥ 100; count > 100; negative/garbage", () => {
		expect(articleChainOf({ ...PART, chain: { root: { fid: 4167, hash: "0xaa" }, index: 2, count: 2 } })).toBeUndefined();
		expect(articleChainOf({ ...HEAD, chain: { index: 100, count: 0 } })).toBeUndefined();
		expect(articleChainOf({ ...HEAD, chain: { index: 0, count: 101 } })).toBeUndefined();
		expect(articleChainOf({ ...HEAD, chain: { index: -1, count: 2 } })).toBeUndefined();
		expect(articleChainOf({ ...HEAD, chain: undefined })).toBeUndefined();
	});
});

describe("isArticleHead / isArticlePart", () => {
	test("the head: format_version 1 at index 0", () => {
		expect(isArticleHead(HEAD)).toBe(true);
		// Unknown format (old shim snapshot) fails closed to a plain cast.
		expect(isArticleHead({ ...HEAD, formatVersion: undefined })).toBe(false);
		expect(isArticleHead({ ...HEAD, formatVersion: 0 })).toBe(false);
		expect(isArticleHead(PART)).toBe(false);
	});

	test("a part: any valid chain with a root, format regardless", () => {
		expect(isArticlePart(PART)).toBe(true);
		// Parts MAY skip format_version (the FIP only says SHOULD).
		expect(isArticlePart({ ...PART, formatVersion: undefined })).toBe(true);
		expect(isArticlePart(HEAD)).toBe(false);
	});
});

describe("articleHeadOf — the title line and the opening", () => {
	test("title is the first line; the blank line after it is not the opening", () => {
		expect(articleHeadOf(HEAD.text ?? "")).toEqual({
			title: "My Article",
			opening: "The opening line, with **bold** and a [link](https://example.com/x).",
		});
	});

	test("a single line is all title, no opening", () => {
		expect(articleHeadOf("Just a title")).toEqual({
			title: "Just a title",
			opening: "",
		});
	});
});

describe("articleCoverOf — the head's single URL embed", () => {
	test("one URL embed is the cover", () => {
		expect(articleCoverOf(HEAD)).toBe("https://imagedelivery.net/BXlu/cover/original");
	});

	test("no embeds — or several — leave no cover", () => {
		expect(articleCoverOf({ ...HEAD, embeds: [] })).toBeUndefined();
		expect(
			articleCoverOf({ ...HEAD, embeds: HEAD.embeds?.concat([{ url: "https://x.test/2" }]) }),
		).toBeUndefined();
	});

	test("castId embeds are not covers", () => {
		expect(articleCoverOf({ ...HEAD, embeds: [{ castId: { fid: 1, hash: "0xaa" } }] })).toBeUndefined();
	});
});

describe("articleOpeningPlain — the blurb and og:description text", () => {
	test("markdown strips: links to labels, bold to words", () => {
		expect(articleOpeningPlain(HEAD.text?.split("\n").slice(2).join("\n") ?? "")).toBe(
			"The opening line, with bold and a link.",
		);
	});

	test("embed-marker lines drop: [$N] and a lone link", () => {
		expect(articleOpeningPlain("Before\n[$1]\nhttps://example.com/pic\nAfter")).toBe(
			"Before\nAfter",
		);
	});

	test("unlabeled links keep their URL; pictures keep their alt", () => {
		expect(articleOpeningPlain("[](https://example.com)")).toBe("https://example.com");
		expect(articleOpeningPlain("![the cover art](https://example.com/c.png)")).toBe(
			"the cover art",
		);
	});

	test("headings, quotes, rules and emphasis flatten; escapes resolve", () => {
		expect(articleOpeningPlain("## Heading\n> quoted\n---\n*em* ~~gone~~ \\*raw\\*")).toBe(
			"Heading\nquoted\nem gone *raw*",
		);
	});
});

describe("articleHeadViewOf — the one predicate every surface renders by", () => {
	test("a well-formed head answers title, opening and cover", () => {
		expect(articleHeadViewOf(HEAD)).toEqual({
			title: "My Article",
			opening: "The opening line, with **bold** and a [link](https://example.com/x).",
			cover: "https://imagedelivery.net/BXlu/cover/original",
		});
	});

	test("not a head, or a head with no title line — undefined, render plain", () => {
		expect(articleHeadViewOf(PART)).toBeUndefined();
		expect(articleHeadViewOf({ ...HEAD, text: "" })).toBeUndefined();
		expect(articleHeadViewOf({ ...HEAD, text: "\n\nopening only" })).toBeUndefined();
	});
});
