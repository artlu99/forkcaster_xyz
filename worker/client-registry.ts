// Client registry: the data behind the cast page's client action row —
// and the URL source for standalone consumers (e.g. the MCP server).
// Adding a client is a data change only — the renderer (cast-actions.tsx),
// the last-used cookie, the /t allow-list, the rank pipeline and the MCP
// tool enum pick it up automatically. No code paths are per-client; the
// roster-guard tests in clients.test.ts are the one place that must be
// updated with the roster, by design.
//
// This module is deliberately dependency-free and cookie-free: it is the
// vendored-into-other-projects surface.
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
// DEEPLINK_SCRIPT (cast-scripts.ts) attempts the app at click time on
// coarse-pointer devices, falling back to the pill's web href. Absent ⇒
// web-only.

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

export type ClientStatus = "active" | "eol" | "suspended";

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
	/**
	 * Cast-eligibility gate for links-only clients: served only when the
	 * cast is KNOWN to carry an external (non-ecosystem) URL embed.
	 * Fail-closed — unknown state hides — the deliberate opposite of
	 * requiresSigned (unsigned authors are rare; link-less casts are the
	 * norm). Shared verbatim with the MCP tool via blockedByLinkGate.
	 * Default false.
	 */
	requiresExternalLinks?: boolean;
	/**
	 * Lifecycle. `eol` (graceful goodbye): the MCP tool answers "no longer
	 * supported"; hidden from the cast page. `suspended` (kill switch — a
	 * client that turned malicious): hidden everywhere, excluded from the
	 * advertised ids, tool answers "suspended"; suspended ids are never
	 * reused. Default: active.
	 */
	status?: ClientStatus;
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
	// Quilibrium's decentralized group messenger renders Farcaster casts in
	// its Feed tab. Scheme VERIFIED against the open-source app
	// (github.com/QuilibriumNetwork/quorum-mobile): the committed
	// AndroidManifest registers scheme "quorummobile" (+ exp+quorum-mobile,
	// no host) and expo-router automatic linking maps the URL path onto
	// routes — app/feed.tsx redirects /feed to the Feed tab PRESERVING query
	// params, where FeedScreen reads castHashPrefix (+ optional username)
	// and SocialFeedModal auto-opens that thread on mount: full 40-hex
	// hashes take the direct hypersnap lookup (isFullCastHash), short
	// prefixes resolve via the username+URL path — hence {fullHash}.
	// WEB HAS NO CAST ROUTE: quorummessenger.com serves the quorum-desktop
	// build (react-router: /messages, /spaces, /farcaster…; /feed 404s), so
	// the https href is an honest homepage stub and the scheme is the only
	// per-cast target. The Feed tab requires a Farcaster account connected
	// inside Quorum — without one the app lands on its sign-in screen.
	{
		id: "quorum",
		title: "Quorum",
		logoUrl: "/logos/quorum.png",
		web: "https://www.quorummessenger.com/",
		deeplink: {
			scheme: "quorummobile://feed?castHashPrefix={fullHash}&username={username}",
			androidPackage: "com.quilibrium.quorummobile",
		},
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
	// matches /(?:0x)?([0-9a-f]{40})/i and strips the prefix internally —
	// lookups key on bare lowercase hex, so the template emits {fullHashRaw}.
	// Re-verified live with and without 0x (both render).
	{
		id: "quilcast",
		title: "Quilcast",
		logoUrl: "/logos/quilcast.svg",
		web: "https://quilcast.com/c/{fullHashRaw}",
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
	// Per-cast format owner-provided + user-verified: the view needs the
	// cast originator's fid (castFid) alongside the hash, so the entry is
	// {fid}-gated — skipped on fid-less surfaces (e.g. the link-only
	// fallback page). castHash wants the full 40 hex, hence {fullHash}.
	{
		id: "vibeshift",
		title: "Vibeshift",
		logoUrl: "/logos/vibeshift.png",
		web: "https://vibeshift.onchain.cooking/?view=cast&castHash={fullHash}&castFid={fid}",
	},
	// Linkcast is a links-only view of Farcaster: "Farcaster, but only the
	// links… a live feed of every cast that shares a link" (ghostlinkz.eth's
	// announcement cast, linkcast.xyz/cast/ad85a07ee52e2c3c9ee0b5d8dbcea44cf47fb185).
	// Per-cast format VERIFIED live (Oct 2026): the site's own routes are
	// /cast/<40 bare hex> (homepage cast links use that spelling) and the
	// 0x-prefixed form renders identically — live checks rendered the right
	// cast at both /cast/895ecc74… and /cast/0x895ecc74… (zoo/0x895ecc74),
	// so the template emits the site-canonical bare hex via {fullHashRaw}.
	// No native app: linkcast.xyz has no assetlinks.json and no deeplink
	// scheme anywhere → web-only. requiresSigned stays unset: the
	// known-unsigned author's cast (decent-artlu/0xbb54368f) renders.
	// requiresExternalLinks is set BY CONTRACT, not implementation: the
	// product is the links-only feed, but the /cast/ route currently
	// renders any cast (gate canonical decent-artlu/0xbb54368f — no
	// embeds — renders with no ineligible notice; kenny/0xa26d1f38 renders
	// with its x.com card). Owner's call: build to the contract — the pill
	// appears only on casts that could plausibly exist in Linkcast's feed,
	// i.e. casts known to carry an external URL embed; if Linkcast ever
	// reports per-cast ineligibility, the entry already matches it.
	{
		id: "linkcast",
		title: "Linkcast",
		logoUrl: "/logos/linkcast.svg",
		web: "https://linkcast.xyz/cast/{fullHashRaw}",
		requiresExternalLinks: true,
	},
];

const isActive = (client: ClientDefinition): boolean =>
	client.status === undefined || client.status === "active";

/**
 * Advertised client ids (MCP `client` enum source): active + eol, never
 * suspended — a suspended id must not be discoverable. eol ids stay so
 * the tool can answer "no longer supported" gracefully.
 */
export const CLIENT_IDS = CLIENTS.filter(
	(client) => client.status !== "suspended",
).map((client) => client.id);

/**
 * Web hostnames of every registry client, derived from the `web`
 * templates (www. and trailing dots stripped) — the taxonomy half of
 * cast-data.ts's internal-link set. Includes eol/suspended hosts:
 * internal-ness is ecosystem taxonomy, not a trust judgment.
 */
export const CLIENT_HOSTS: string[] = CLIENTS.filter(
	(client) => client.web !== undefined,
).map((client) =>
	new URL(client.web as string)
		.hostname.toLowerCase()
		.replace(/\.+$/, "")
		.replace(/^www\./, ""),
);

/**
 * The eligibility gate shared by the pill row (clientsForPage) and the
 * MCP tool (buildAll + get_cast_link): a requiresExternalLinks client is
 * offered only when the cast is KNOWN to carry an external URL embed;
 * `undefined` (no cast data) blocks.
 */
export function blockedByLinkGate(
	client: ClientDefinition,
	externalLinks: boolean | undefined,
): boolean {
	return client.requiresExternalLinks === true && externalLinks !== true;
}

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
const PLACEHOLDERS = [
	"username",
	"hash",
	"fullHash",
	"fullHashRaw",
	"fid",
] as const;

/** {fullHashRaw} derives from {fullHash}: bare lowercase hex, no 0x prefix. */
function placeholderValue(
	name: (typeof PLACEHOLDERS)[number],
	vars: TemplateVars,
): string | undefined {
	if (name === "fullHashRaw") {
		return vars.fullHash.replace(/^0x/i, "").toLowerCase();
	}
	if (name === "fid") {
		return vars.fid === undefined ? undefined : String(vars.fid);
	}
	return vars[name];
}

/** Template placeholders with no value in these vars — such clients are skipped. */
export function missingVars(tpl: string, vars: TemplateVars): string[] {
	return PLACEHOLDERS.filter(
		(name) => tpl.includes(`{${name}}`) && placeholderValue(name, vars) === undefined,
	);
}

export function resolveTemplate(tpl: string, vars: TemplateVars): string {
	let out = tpl;
	for (const name of PLACEHOLDERS) {
		const value = placeholderValue(name, vars);
		if (value === undefined) continue;
		out = out.replaceAll(`{${name}}`, encodeURIComponent(value));
	}
	return out;
}

/**
 * Clients offered on the cast page, in registry order: must have a web
 * URL whose placeholders are all satisfied, must not be suppressed
 * by the signed rule (farcaster.xyz hides unsigned authors; the
 * suppression is fail-open, so only a known signed:false hides anything),
 * and must pass the external-link gate (requiresExternalLinks clients
 * are fail-closed: hidden unless the cast is known to carry an external
 * URL embed — see blockedByLinkGate).
 */
export function clientsForPage(
	signed: boolean,
	vars: TemplateVars,
	externalLinks?: boolean,
): ClientDefinition[] {
	return CLIENTS.filter(
		(client) =>
			isActive(client) &&
			client.web !== undefined &&
			missingVars(client.web, vars).length === 0 &&
			!(client.requiresSigned === true && signed === false) &&
			!blockedByLinkGate(client, externalLinks),
	);
}

/** Cookie value → client. Unknown, absent, or non-active values yield nothing. */
export function findClient(
	id: string | undefined,
): ClientDefinition | undefined {
	if (id === undefined) return undefined;
	const client = CLIENTS.find((entry) => entry.id === id);
	return client !== undefined && isActive(client) ? client : undefined;
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
