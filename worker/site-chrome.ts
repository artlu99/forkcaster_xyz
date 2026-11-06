// Host chrome for the two domains this worker serves. forkcaster.xyz is
// the canonical origin (PRIMARY_ORIGIN); warpcats.com is the same pages
// under its own name. Detection is the request hostname — one deploy,
// two custom domains (wrangler routes).

export type SiteName = "forkcaster" | "warpcats";

/** A listed FarCat small enough to sit in the header. */
export type FarcatPreview = {
	/** Metadata name, e.g. "FarCats #1648". Token id and display number differ. */
	name: string;
	tokenId: string;
	/** https image, already thumbnail-sized when it comes from the CDN. */
	imageUrl: string;
	/** Listing price, e.g. "0.0008899 ETH". Absent only if a future source has no ask. */
	priceLabel?: string;
	/** OpenSea item page for this token id. */
	href: string;
};

export type SiteChrome = {
	site: SiteName;
	farcat: FarcatPreview | null;
};

export function siteNameForHost(hostname: string): SiteName {
	const host = hostname.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
	if (host === "warpcats.com" || host === "www.warpcats.com") return "warpcats";
	return "forkcaster";
}
