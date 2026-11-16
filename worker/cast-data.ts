// Shim → react-farcaster-embed data mapping and the embed-shape helpers
// shared by both renderers. Pure functions — no fetches, no env. The I/O
// around this mapping (unfurl, quote hydration) lives in cast-page.tsx.

import type { FarcasterEmbed } from "react-farcaster-embed";
import { CLIENT_HOSTS } from "./client-registry.ts";
import type { ShimCast } from "./shim.ts";

export type CastData = NonNullable<
	Parameters<typeof FarcasterEmbed>[0]["castData"]
>;

// Shim embeds are raw message items: {url} or {castId} quotes, untyped.
// Warpcast-hosted cast images live on imagedelivery.net; external images
// usually carry an image extension. Everything else renders as a link embed.
export function isImageUrl(url: string): boolean {
	return (
		/imagedelivery\.net\//i.test(url) ||
		/\.(png|jpe?g|gif|webp|avif)([?#]|$)/i.test(url)
	);
}

// Quote embeds are dropped, not rendered: the bundle reads
// quote.author.pfp.url unguarded and Shim's message-level embeds carry no
// hydrated author data, so any quote card would either crash the page or
// render as an empty shell. URL embeds render as link cards via openGraph.
function urlOpenGraph(url: string): {
	url: string;
	domain: string;
	title: string;
} {
	try {
		const parsed = new URL(url);
		return { url, domain: parsed.hostname, title: parsed.hostname };
	} catch {
		return { url, domain: "", title: "" };
	}
}

// unfurl.artlu.workers.dev enriches URL embeds with Open Graph data
// (title/description/image); owner-run, cached, CORS-open. Failures fall
// back to hostname-only cards.
export type UnfurlResult = {
	ogTitle?: string;
	twitterTitle?: string;
	ogDescription?: string;
	twitterDescription?: string;
	ogImage?: Array<{ url?: string } | string>;
};

/**
 * The author handle a surface should carry — the identity law: the fname
 * is the account's PRIMARY handle (the first name); any number of ENS
 * names are attestations. `username` on
 * shim answers is the NEWEST proof and stays the backward-compat shape,
 * so primary prefers fname and falls back through it to the caller's own
 * fallback (usually the gate-validated route input). Absent user (raw
 * partial wins, old shim) degrades to the fallback — today's bytes.
 */
export function primaryHandle(
	user:
		| {
				fname?: string | null;
				username?: string | null;
		  }
		| undefined,
	fallback: string,
): string {
	return user?.fname ?? user?.username ?? fallback;
}

/**
 * The display waterfall: displayName → username → fname. For NAME slots —
 * the embed library renders author.displayName with NO fallback (an empty
 * <p> for a no-displayName author), so this guarantees something human
 * always renders on the card. NOT @-safe (displayName may carry emoji and
 * spaces): never feed it to an @handle or URL slot — identity/route slots
 * keep primaryHandle (fname-first — the identity law).
 */
export function displayNameOf(
	user:
		| {
				displayName?: string | null;
				username?: string | null;
				fname?: string | null;
		  }
		| undefined,
): string {
	const name = user?.displayName?.trim();
	if (name) return name;
	return user?.username?.trim() || user?.fname?.trim() || "";
}

export function toCastData(
	cast: ShimCast,
	unfurled?: Map<string, UnfurlResult | undefined>,
	quotes?: Array<ShimCast | undefined>,
): CastData {
	const images: Array<{
		type: string;
		url: string;
		sourceUrl: string;
		alt: string;
	}> = [];
	const urls: Array<{
		type: string;
		openGraph: Record<string, string | boolean>;
	}> = [];
	for (const embed of cast.embeds ?? []) {
		if (embed.castId?.hash) continue;
		if (embed.url && isImageUrl(embed.url)) {
			images.push({
				type: "image",
				url: embed.url,
				sourceUrl: embed.url,
				alt: "",
			});
		} else if (embed.url) {
			urls.push({
				type: "url",
				openGraph: openGraphFor(embed.url, unfurled?.get(embed.url)),
			});
		}
	}
	const quoteCasts: CastData[] = [];
	for (const quote of quotes ?? []) {
		// Recursion depth 1: hydrated quotes render without their own quotes.
		if (quote?.hash) quoteCasts.push(toCastData(quote));
	}
	// The embed bundle reads e.recasts.count and e.tags.length unguarded, and
	// Shim's message data carries no engagement counts — stub them with zeros
	// so rendering can't crash. The zero-count stats row itself is stripped
	// from the SSR output after render (STATS_ROW below).
	return {
		hash: cast.hash,
		text: cast.text,
		timestamp: cast.timestamp === undefined ? undefined : cast.timestamp * 1000,
		author: {
			fid: cast.user?.fid,
			username: cast.user?.username,
			// Display waterfall (displayNameOf): the library renders this
			// raw with no fallback — without it a no-displayName author
			// shows an empty name <p>. The @handle below stays the
			// newest-proof username by design.
			displayName: displayNameOf(cast.user),
			pfp: { url: cast.user?.pfpUrl },
			profile: cast.user?.bio ? { bio: { text: cast.user.bio } } : undefined,
		},
		embeds: { images, urls, casts: quoteCasts },
		replies: { count: 0 },
		reactions: { count: 0 },
		recasts: { count: 0 },
		tags: [],
	};
}

function openGraphFor(
	url: string,
	data?: UnfurlResult,
): Record<string, string | boolean> {
	const title = data?.ogTitle ?? data?.twitterTitle ?? urlOpenGraph(url).title;
	const description = data?.ogDescription ?? data?.twitterDescription;
	const first = data?.ogImage?.[0];
	const image = typeof first === "string" ? first : first?.url;
	return {
		url,
		domain: urlOpenGraph(url).domain,
		title,
		...(description ? { description } : {}),
		...(image ? { image, useLargeImage: true } : {}),
	};
}

// Collapse newlines/whitespace and truncate for meta description attributes.
export function toDescription(text: string, cap = 280): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

// OG description with the quoted cast folded in: link-preview bots never
// run the client-side quote fill-in, so a quote-cast embed otherwise hides
// the very cast being quoted. Only HYDRATED quotes with a resolvable
// handle contribute (OG meta never depends on quotes for well-formedness —
// a quote-blind partial win simply omits the line). The parent text
// shrinks to 200 chars when a quote line rides along — bots truncate
// around there, so the quote must start early enough to be seen.
// Quote-less casts render byte-identically to the plain toDescription form.
export function toOgDescription(
	text: string | undefined,
	quotes: Array<ShimCast | undefined>,
): string | undefined {
	const lines: string[] = [];
	for (const quote of quotes) {
		if (lines.length >= 2) break;
		const handle = primaryHandle(quote?.user, "");
		if (!handle || !quote?.hash) continue;
		const quoteText = quote.text ? toDescription(quote.text, 120) : "";
		lines.push(`> @${handle}:${quoteText ? ` ${quoteText}` : ""}`);
	}
	const parent = text
		? toDescription(text, lines.length > 0 ? 200 : 280)
		: undefined;
	if (!parent && lines.length === 0) return undefined;
	// Blank line between the parent text and the quote block; quote lines
	// stay tight together (blank lines eat into bot truncation budgets).
	if (!parent) return lines.join("\n");
	if (lines.length === 0) return parent;
	return `${parent}\n\n${lines.join("\n")}`;
}

// The bundle renders a replies/recasts/likes row from engagement data the
// Shim doesn't carry — without the toCastData zero stubs rendering would
// crash, with them it would always show hardcoded zeros. Strip the row from
// the SSR output; the Farcaster logo in the same container stays. The stats
// <ul> is the only <ul> in the card and contains no user text, so matching
// on the container class is exact. The replacement re-opens the container
// with data attributes so the client-side live-stats script can find it.
export const STATS_ROW = /(<div class="farcaster-embed-stats">)<ul>[\s\S]*?<\/ul>/;

// URL embeds destined for unfurl enrichment: deduped, capped at 3.
// Shared by resolve (which performs the unfurls) and the JSON renderer
// (which must describe exactly the same list).
export function urlEmbedsOf(cast: ShimCast): string[] {
	return Array.from(
		new Set(
			(cast.embeds ?? [])
				.map((embed) => embed.url)
				.filter((u): u is string => typeof u === "string" && !isImageUrl(u)),
		),
	).slice(0, 3);
}

// Quote embeds destined for Shim hydration: capped at 3. Each target
// carries the embed's castId fid beside the hash — /h is a hash-only index
// that misses live casts (measured Oct 2026), and the fid is what makes
// fetchQuote's /u → /wc fallback possible. Same sharing story as
// urlEmbedsOf: resolve hydrates, the JSON renderer pairs against the
// results position by position.
export type QuoteTarget = { hash: string; fid?: number };

export function quoteTargetsOf(cast: ShimCast): QuoteTarget[] {
	const targets: QuoteTarget[] = [];
	for (const embed of cast.embeds ?? []) {
		const { hash, fid } = embed.castId ?? {};
		if (typeof hash !== "string") continue;
		targets.push(typeof fid === "number" ? { hash, fid } : { hash });
	}
	return targets.slice(0, 3);
}

// Image embed URLs in embed order. The HTML renderer uses the first for
// og:image; the JSON renderer lists all of them.
export function imageUrlsOf(cast: ShimCast): string[] {
	return (cast.embeds ?? [])
		.map((embed) => embed.url)
		.filter((u): u is string => typeof u === "string" && isImageUrl(u));
}

// --- Internal/external link gate --------------------------------------------
//
// Classifies URL embeds as ecosystem-internal (warpcast.com, forkcaster's
// own domains, and every registry client's web host via CLIENT_HOSTS) or
// external (the open web). Consumer: client eligibility — a
// `requiresExternalLinks` client (links-only, e.g. Linkcast) is offered
// only when the cast carries an external URL embed; blockedByLinkGate
// shares that predicate with the MCP tool. Deduped and uncapped like
// urlEmbedsOf — the 3-cap stays an unfurl-budget concern.

/** Hosts with no registry `web` template to derive them from. */
const CORE_INTERNAL_HOSTS = [
	"warpcast.com", // legacy app host (redirects to farcaster.xyz)
	"forkcaster.xyz", // this service, primary origin
	"warpcats.com", // this service, secondary origin
] as const;

const INTERNAL_HOSTS: ReadonlySet<string> = new Set([
	...CORE_INTERNAL_HOSTS,
	...CLIENT_HOSTS,
]);

export type LinkClass = "internal" | "external";

/**
 * Classifies a URL by its host (scheme ignored beyond http(s)
 * parsability). Unparseable and non-web URLs classify as external —
 * fail open: the worst case is one wasted link-card fetch. Hosts match
 * equals-or-subdomain; the leading dot defeats lookalikes.
 */
export function classifyUrl(
	url: string,
	hosts: Iterable<string> = INTERNAL_HOSTS,
): LinkClass {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return "external";
		}
		const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
		for (const known of hosts) {
			if (host === known || host.endsWith(`.${known}`)) return "internal";
		}
		return "external";
	} catch {
		return "external";
	}
}

/**
 * External URL embeds in embed order — the uncapped sibling of
 * urlEmbedsOf: same dedupe shape, plus the internal-link filter.
 */
export function externalUrlEmbedsOf(
	cast: ShimCast,
	hosts: Iterable<string> = INTERNAL_HOSTS,
): string[] {
	return Array.from(
		new Set(
			(cast.embeds ?? [])
				.map((embed) => embed.url)
				.filter(
					(u): u is string =>
						typeof u === "string" &&
						u !== "" &&
						!isImageUrl(u) &&
						classifyUrl(u, hosts) === "external",
				),
		),
	);
}

// --- Farcaster Articles (cast chains) ---------------------------------------
//
// An article is a chain of casts by one author (the "Cast Format and Chained
// Casts" FIP): every cast carries `chain` (the first cast's id, its index
// from 0 and the cast count) and `format_version` 1 — its text is article
// Markdown. The cast at index 0 holds the title on its first line, then an
// optional empty line and the opening; its single URL embed, if any, is the
// cover image. Every later cast replies to the one before it, so clients
// that don't know articles see a thread. Reading rules mirror quilcast's
// src/article.ts (the reference reader): nodes only check the chain rules
// once the feature is active, so readers re-check them.

/** MAX_CHAIN_PARTS: a chain has at most 100 casts. */
export const ARTICLE_MAX_PARTS = 100;

/** A chain that passed the FIP's reading rules — `index`/`count`
 *  normalized (protobuf's omitted zeros filled), `root` present exactly
 *  when `index` > 0, with the hash narrowed to string. */
export type ValidatedChain = {
	root?: { fid?: number; hash: string };
	index: number;
	count: number;
};

/**
 * The cast's chain, with the FIP's rules re-checked: at most 100 casts, an
 * index below 100 and below `count` when count is set, no root at index 0,
 * and the author's own cast as root otherwise. A chain that breaks one is
 * rejected outright — the cast reads as an ordinary one.
 */
export function articleChainOf(cast: ShimCast): ValidatedChain | undefined {
	const chain = cast.chain;
	if (!chain || typeof chain !== "object") return undefined;
	// Protobuf JSON leaves out zeros.
	const index = chain.index ?? 0;
	const count = chain.count ?? 0;
	const safe = (v: number) =>
		Number.isSafeInteger(v) && v >= 0 ? v : undefined;
	const at = safe(index);
	const total = safe(count);
	if (at === undefined || total === undefined) return undefined;
	if (total > ARTICLE_MAX_PARTS || at >= ARTICLE_MAX_PARTS) return undefined;
	if (total > 0 && at >= total) return undefined;
	if (at === 0) return chain.root ? undefined : { index: at, count: total };
	const root = chain.root;
	if (!root || typeof root.hash !== "string" || root.hash === "") return undefined;
	if (typeof root.fid === "number" && root.fid !== cast.fid) return undefined;
	return { root: { fid: root.fid, hash: root.hash }, index: at, count: total };
}

/**
 * The first cast of an article (index 0, article Markdown): the head that
 * renders as an article with cover, title and intro. Unknown formatVersion
 * (old shim snapshot) is not a head — fail closed to the plain card.
 */
export function isArticleHead(cast: ShimCast): boolean {
	return cast.formatVersion === 1 && articleChainOf(cast)?.index === 0;
}

/**
 * A later cast of an article chain (index ≥ 1): an internal intermediate of
 * an article — the "1 of N or greater" casts. Whether its chain really is an
 * article is the head's to say (its formatVersion may be missing); call this
 * only where hiding from a list is the cost of being wrong.
 */
export function isArticlePart(cast: ShimCast): boolean {
	const chain = articleChainOf(cast);
	return chain !== undefined && chain.index > 0 && chain.root !== undefined;
}

/**
 * The head cast's title (first line) and opening (what follows the empty
 * line after it) — the whole article the head carries; the body lives in
 * the later parts and stays there.
 */
export function articleHeadOf(text: string): { title: string; opening: string } {
	const nl = text.indexOf("\n");
	return {
		title: (nl < 0 ? text : text.slice(0, nl)).trim(),
		opening: nl < 0 ? "" : text.slice(nl + 1).replace(/^\n/, ""),
	};
}

/**
 * The cover: the head's single URL embed (the FIP gives the head at most
 * one embed — the cover image). Anything else (no embeds, several) leaves
 * no cover.
 */
export function articleCoverOf(cast: ShimCast): string | undefined {
	const urls = (cast.embeds ?? [])
		.map((embed) => embed.url)
		.filter((u): u is string => typeof u === "string" && u !== "");
	return urls.length === 1 ? urls[0] : undefined;
}

// Lines the opening carries only as embed markers, not prose: `[$N]` — the
// cast's Nth embed, where the text has it — and a link alone on a line (a
// link preview). Both render as cards, so the plain opening drops them.
const ARTICLE_PLACEHOLDER = /^\[\$\d{1,2}\]$/;
const ARTICLE_LONE_LINK = /^https?:\/\/\S+$/;

/** Strip the article Markdown a plain excerpt cannot show: links become
 * their label (an unlabeled link its URL), pictures their alt text,
 * emphasis/strike/code their contents, headings/quotes/rules their bare
 * lines. Escapes resolve (`\*` → `*`); a line's carry-on backslash goes. */
function articlePlain(text: string): string {
	return text
		.replace(/!\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, (_m, alt: string) => alt)
		.replace(
			/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
			(_m, label: string, url: string) => label || url,
		)
		.replace(/^#{1,6} +/gm, "")
		.replace(/^>+ ?/gm, "")
		.replace(/^ {0,3}(?:[-*_] *){3,}\n?/gm, "")
		.replace(/(\*\*\*|\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
		.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/(^|[^\w\\])\*(?=\S)([\s\S]*?\S)\*(?!\w)/g, "$1$2")
		.replace(/(^|[^\w\\])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1$2")
		.replace(/\\([\\*_~+[\]`#>|])/g, "$1")
		.replace(/\\$/gm, "")
		.trim();
}

/**
 * The opening as a plain text blurb shows it: embed-marker lines dropped
 * (`[$N]`, a link alone on a line — they render as cards), then the
 * Markdown stripped. Newlines survive (paragraphs); callers that need one
 * line collapse whitespace (toDescription does it for og:description).
 */
export function articleOpeningPlain(opening: string): string {
	const lines = (opening ?? "")
		.split("\n")
		.filter((line) => {
			const t = line.trim();
			return !ARTICLE_PLACEHOLDER.test(t) && !ARTICLE_LONE_LINK.test(t);
		});
	return articlePlain(lines.join("\n"));
}

/**
 * The head cast as the article it presents: title, opening and cover —
 * or undefined when it isn't a well-formed head (not article Markdown, not
 * index 0, no title line). One predicate for every surface: a page and a
 * list render the article view exactly when this answers.
 */
export function articleHeadViewOf(
	cast: ShimCast,
): { title: string; opening: string; cover?: string } | undefined {
	if (!isArticleHead(cast)) return undefined;
	const { title, opening } = articleHeadOf(cast.text ?? "");
	if (!title) return undefined;
	return { title, opening, cover: articleCoverOf(cast) };
}

/**
 * True iff the cast carries ≥1 external URL embed. The exact negative is
 * what the eligibility gate relies on — no external links ⇒ a links-only
 * client cannot serve this cast — while a true only means "might be
 * eligible" (the client's own filtering decides the rest).
 */
export function hasExternalLinks(
	cast: ShimCast,
	hosts: Iterable<string> = INTERNAL_HOSTS,
): boolean {
	return externalUrlEmbedsOf(cast, hosts).length > 0;
}
