// Floor FarCat for the warpcats.com header.
//
// FarCats (ERC-721, Ethereum mainnet):
//   contract  0x9340204616750cb61e56437befc95172c6ff6606
//   supply    1661, token ids 1..1661 (tokenURI reverts outside that)
//   tokenURI  ipfs://bafybeihmvw76onxym6svwbg5uh5ztydxz7myx3fre4bus6w7gic6xn6qsi/<id>
//   name      "FarCats"; the metadata name ("FarCats #9") is not the token id
//
// OpenSea:
//   collection  https://opensea.io/collection/farcats
//   item        https://opensea.io/item/ethereum/<contract>/<tokenId>
// The public API requires a key this worker does not have. The collection
// page's server render embeds the current listings (token id, metadata
// name, seadn image, best ask). One fetch, parsed below, cached per
// isolate. The image URL gets ?w=64&h=64 — seadn then returns ~2KB, which
// is the right weight for a 32px header mark. A miss leaves the header
// without a cat; the page never waits on a second gateway.

import type { FarcatPreview } from "./site-chrome.ts";

const CONTRACT = "0x9340204616750cb61e56437befc95172c6ff6606";
const COLLECTION_URL = "https://opensea.io/collection/farcats";

const FLOOR_TTL_MS = 15 * 60 * 1000;
const MISS_TTL_MS = 45 * 1000;
const FETCH_MS = 1500;

const IMAGE_RE =
	/https:\/\/i2c\.seadn\.io\/ethereum\/0x9340204616750cb61e56437befc95172c6ff6606\/[a-z0-9]+\.(?:jpe?g|png|gif|webp)/;
const NAME_RE = /"name":"(FarCats #\d+)"/;
const LISTING_RE =
	/"bestListing":\{[\s\S]{0,700}?"unit":(\d+(?:\.\d+)?)[\s\S]{0,200}?"symbol":"(ETH|WETH)"/;

type CacheEntry = { preview: FarcatPreview | null; until: number };

let cached: CacheEntry | undefined;
let pending: Promise<FarcatPreview | null> | null = null;

/** Tests reset the isolate cache between cases. */
export function clearFarcatCache(): void {
	cached = undefined;
	pending = null;
}

export function loadFarcatPreview(): Promise<FarcatPreview | null> {
	if (cached && Date.now() < cached.until) return Promise.resolve(cached.preview);
	if (!pending) {
		pending = resolveFloor().finally(() => {
			pending = null;
		});
	}
	return pending;
}

async function resolveFloor(): Promise<FarcatPreview | null> {
	const preview = await fetchFloor();
	cached = {
		preview,
		until: Date.now() + (preview ? FLOOR_TTL_MS : MISS_TTL_MS),
	};
	return preview;
}

async function fetchFloor(): Promise<FarcatPreview | null> {
	try {
		const res = await fetch(COLLECTION_URL, {
			signal: AbortSignal.timeout(FETCH_MS),
			headers: {
				accept: "text/html",
				// The listings live in the browser document. A bare worker
				// UA is served a shell without them.
				"user-agent":
					"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
			},
			cache: "no-store",
		});
		if (!res.ok) return null;
		const html = await res.text();
		if (html.length > 3_000_000) return null;
		return parseFloorFarcat(html);
	} catch {
		return null;
	}
}

/**
 * Cheapest listed FarCat in an OpenSea collection document. Returns null
 * when the listings block is missing or no item has an ask, a FarCats
 * name, and a seadn image under this contract — never a partial.
 */
export function parseFloorFarcat(html: string): FarcatPreview | null {
	const start = html.indexOf('"collectionItems"');
	if (start < 0) return null;
	const slice = html.slice(start, start + 800_000);
	let best: { value: number; preview: FarcatPreview } | null = null;
	for (const part of slice.split('"tokenId":').slice(1)) {
		const id = /^"(\d+)"/.exec(part);
		const name = NAME_RE.exec(part);
		const image = IMAGE_RE.exec(part);
		const listing = LISTING_RE.exec(part);
		if (!id || !name || !image || !listing) continue;
		const value = Number(listing[1]);
		if (!Number.isFinite(value) || value <= 0) continue;
		if (best && value >= best.value) continue;
		const tokenId = id[1] ?? "";
		best = {
			value,
			preview: {
				name: name[1] ?? "",
				tokenId,
				imageUrl: `${image[0]}?w=64&h=64`,
				priceLabel: `${listing[1]} ${listing[2]}`,
				href: `https://opensea.io/item/ethereum/${CONTRACT}/${tokenId}`,
			},
		};
	}
	return best?.preview ?? null;
}
