// Shim → react-farcaster-embed data mapping and the embed-shape helpers
// shared by both renderers. Pure functions — no fetches, no env. The I/O
// around this mapping (unfurl, quote hydration) lives in cast-page.tsx.

import type { FarcasterEmbed } from "react-farcaster-embed";
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
export function toDescription(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 280 ? `${flat.slice(0, 279)}…` : flat;
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

// Quote embeds destined for Shim /h hydration: capped at 3. Same sharing
// story as urlEmbedsOf: resolve hydrates, the JSON renderer pairs against
// the results position by position.
export function quoteHashesOf(cast: ShimCast): string[] {
	return (cast.embeds ?? [])
		.map((embed) => embed.castId?.hash)
		.filter((h): h is string => typeof h === "string")
		.slice(0, 3);
}

// Image embed URLs in embed order. The HTML renderer uses the first for
// og:image; the JSON renderer lists all of them.
export function imageUrlsOf(cast: ShimCast): string[] {
	return (cast.embeds ?? [])
		.map((embed) => embed.url)
		.filter((u): u is string => typeof u === "string" && isImageUrl(u));
}
