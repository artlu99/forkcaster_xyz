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
 * The author handle a surface should carry — the identity law (2026-10-27
 * rethink of "canonical"): the fname is the account's PRIMARY handle (the
 * first name); any number of ENS names are attestations. `username` on
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
			displayName: cast.user?.displayName,
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
		lines.push(`↷ @${handle}:${quoteText ? ` ${quoteText}` : ""}`);
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
