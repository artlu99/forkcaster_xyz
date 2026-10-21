// Client registry: the modular schema behind the cast page's client
// action row. Adding a client is a data change only — the renderer
// (cast-page.tsx), the last-used cookie and the badge pick it up
// automatically. No code paths are per-client.
//
// URL templates interpolate {username}, {hash} (route-form hash, short
// or full, exactly as requested) and {fullHash} (as resolved by Shim).
// Templates are first-party constants; interpolated values are
// percent-encoded here and HTML-escaped at render time.
//
// `deeplink` is an optional native mobile target: a verified per-cast
// custom scheme (plus optional Android package id, which switches Android
// to the intent:// form with a Chrome-native fallback). When a rendered
// client has one, the pill gains data-scheme/data-intent attributes and
// DEEPLINK_SCRIPT (cast-page.tsx) attempts the app at click time on
// coarse-pointer devices, falling back to the pill's web href. Absent ⇒
// web-only.

/** Cookie that remembers the visitor's last-used client. */
export const LAST_CLIENT_COOKIE = "fc_client";
/** 1 year. */
export const LAST_CLIENT_MAX_AGE = 60 * 60 * 24 * 365;

export interface DeeplinkTarget {
	/**
	 * Verified per-cast custom scheme, e.g. "firefly://post/farcaster/{fullHash}".
	 * Attempted on mobile only, with the resolved web URL as fallback —
	 * never rendered as the pill href.
	 */
	scheme: string;
	/**
	 * Android package id: on Android the click composes an intent:// URL
	 * (native fallback handled by Chrome via S.browser_fallback_url)
	 * instead of the raw scheme.
	 */
	androidPackage?: string;
}

export interface ClientDefinition {
	/** Stable slug — the cookie value and the badge lookup key. */
	id: string;
	/** Pill label. */
	title: string;
	/** Client-specific mark, served from /public/logos/. */
	logoUrl: string;
	/**
	 * Per-cast https URL — the canonical pill target on every platform.
	 * Universal links open installed apps on mobile; otherwise a browser.
	 * A template without placeholders (homepage) is an explicit stub:
	 * the client's per-cast format is not verified yet.
	 */
	web?: string;
	/** Native app target — activates the mobile scheme attempt. Absent ⇒ web-only. */
	deeplink?: DeeplinkTarget;
	/**
	 * Hide when the author hasn't signed the social smart contract (the
	 * farcaster.xyz rule). Unknown signed-state fails open. Default false.
	 */
	requiresSigned?: boolean;
}

export const CLIENTS: ClientDefinition[] = [
	{
		id: "farcaster",
		title: "Farcaster",
		logoUrl: "/logos/farcaster.svg",
		web: "https://farcaster.xyz/{username}/{hash}",
		// Scheme VERIFIED against the open-source app (github.com/farcasterxyz/
		// client): useHandleDeepLink rewrites farcaster:// → https://farcaster.xyz/
		// and routes the remainder as a web path, where parseCastUrl accepts
		// /{username}/{hash} with FULL (0x+40 hex) or short (0x+8-39 hex) hashes.
		// The legacy 2023 /casts/:fname/:hash route is GONE — it would now match
		// /:username and open a bogus profile for the user "casts". {fullHash} is
		// used because the route-form hash may be shorter than the 8-hex minimum.
		// Android manifest: scheme "farcaster" (no warpcast://) + autoVerify for
		// warpcast.com and farcaster.xyz. iOS CFBundleURLSchemes: farcaster,
		// com.farcaster.mobile-client, exp+farcaster.
		deeplink: {
			scheme: "farcaster://{username}/{fullHash}",
			androidPackage: "com.farcaster.mobile",
		},
		requiresSigned: true,
	},
	{
		id: "firefly",
		title: "Firefly",
		logoUrl: "/logos/firefly.png",
		// iOS app claims /post/* in its AASA and Android package
		// io.dimension.firefly is in assetlinks.json — the web URL opens
		// the native app on both platforms. No per-cast custom scheme is
		// documented anywhere; web-only until one surfaces.
		web: "https://firefly.social/post/farcaster/{fullHash}",
	},
	// Per-cast format verified against the open-source client
	// (github.com/backmeupplz/quilcast, server/index.mjs): the /c/ route
	// matches /(?:0x)?([0-9a-f]{40})/ — {fullHash} required, the route
	// hash can be shorter. Live-checked against a real cast.
	{
		id: "quilcast",
		title: "Quilcast",
		logoUrl: "/logos/quilcast.svg",
		web: "https://quilcast.com/c/{fullHash}",
	},
	// Per-cast format verified against fc-clients-cast-action
	// (github.com/artlu99/fc-clients-cast-action, src/lib/deeplink.ts):
	// frame castId hashes are always full-form, hence {fullHash}.
	{
		id: "neynar",
		title: "Neynar",
		logoUrl: "/logos/neynar.png",
		web: "https://explorer.neynar.com/{fullHash}",
	},
	// Per-cast format owner-provided and live-checked (200, renders the
	// cast view): query-param form, {fullHash} — short-hash support
	// unverified, the route-form hash can be shorter than 40 hex.
	{
		id: "vibeshift",
		title: "Vibeshift",
		logoUrl: "/logos/vibeshift.svg",
		web: "https://vibeshift.onchain.cooking/?view=cast&castHash={fullHash}",
	},
];

export interface TemplateVars {
	username: string;
	/** Route-form hash, short or full, exactly as requested. */
	hash: string;
	/** Full hash as resolved by Shim. */
	fullHash: string;
	/** Author fid — optional; reserved for templates that need it. */
	fid?: number;
}

/** Placeholders a template may reference; `fid` is the only optional one. */
const PLACEHOLDERS = ["username", "hash", "fullHash", "fid"] as const;

/** Template placeholders with no value in these vars — such clients are skipped. */
export function missingVars(tpl: string, vars: TemplateVars): string[] {
	return PLACEHOLDERS.filter(
		(name) => tpl.includes(`{${name}}`) && vars[name] === undefined,
	);
}

export function resolveTemplate(tpl: string, vars: TemplateVars): string {
	return tpl
		.replaceAll("{username}", encodeURIComponent(vars.username))
		.replaceAll("{hash}", encodeURIComponent(vars.hash))
		.replaceAll("{fullHash}", encodeURIComponent(vars.fullHash))
		.replaceAll("{fid}", vars.fid === undefined ? "" : String(vars.fid));
}

/**
 * Clients offered on the cast page, in registry order: must have a web
 * URL whose placeholders are all satisfied, and must not be suppressed
 * by the signed rule (farcaster.xyz hides unsigned authors; the
 * suppression is fail-open, so only a known signed:false hides anything).
 */
export function clientsForPage(
	signed: boolean,
	vars: TemplateVars,
): ClientDefinition[] {
	return CLIENTS.filter(
		(client) =>
			client.web !== undefined &&
			missingVars(client.web, vars).length === 0 &&
			!(client.requiresSigned === true && signed === false),
	);
}

/** Cookie value → client. Unknown or absent values yield nothing. */
export function findClient(id: string | undefined): ClientDefinition | undefined {
	if (id === undefined) return undefined;
	return CLIENTS.find((client) => client.id === id);
}

/**
 * Native click-time targets for a client, resolved per cast. Returned
 * to the renderer as data attributes; the pill href stays the web URL
 * on every platform. When both are present the client script picks per
 * platform: Android uses `intent` (Chrome-native fallback), iOS and
 * other coarse-pointer devices use `scheme`.
 *
 * - `scheme`: raw custom scheme, attempted on mobile with the web URL
 *   as visibility-aware fallback (see DEEPLINK_SCRIPT).
 * - `intent`: Android intent:// URL when an androidPackage is set —
 *   Chrome natively falls back to the encoded web URL in that form.
 * - neither: the client is web-only.
 */
export function deeplinkTargets(
	client: ClientDefinition,
	vars: TemplateVars,
): { scheme?: string; intent?: string } {
	if (!client.deeplink || !client.web) return {};
	const scheme = resolveTemplate(client.deeplink.scheme, vars);
	const sep = scheme.indexOf("://");
	if (client.deeplink.androidPackage && sep > 0) {
		const web = resolveTemplate(client.web, vars);
		return {
			scheme,
			intent: `intent://${scheme.slice(sep + 3)}#Intent;scheme=${scheme.slice(0, sep)};package=${client.deeplink.androidPackage};S.browser_fallback_url=${encodeURIComponent(web)};end`,
		};
	}
	return { scheme };
}
