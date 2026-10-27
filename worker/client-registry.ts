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

/**
 * A route kind: the thing a client target points at. `cast` is the
 * original surface (the existing `web`/`deeplink` fields); the others are
 * additive targets on the same entries. One vocabulary — track.ts and the
 * renderers import this, never a second enum.
 */
export type RouteKind = "cast" | "profile" | "feed" | "channel";

/**
 * A per-thing client target: one verified https URL (universal links on
 * mobile, browser otherwise) plus an optional native scheme. A homepage
 * stub `web` is an honest, documented shape when only the scheme is
 * verified (quorum's entries) — the scheme is the real target, the href
 * the no-app fallback.
 *
 * `pointer` scopes the pill to a pointer class (the established
 * `.fine-only` / `.coarse-only` CSS mechanism: the markup ships
 * byte-identical for every device, CSS picks, `pointer: none` sees both).
 * Absent = universal.
 */
export interface ClientTarget {
	web: string;
	deeplink?: DeeplinkTarget;
	pointer?: "fine" | "coarse";
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
	 * Non-cast targets: the capability matrix. The registry is the
	 * single source of truth for verified per-thing URL facts — renderers
	 * resolve through targetFor/targetDeeplinkTargets and keep only their
	 * own markup. A kind without a target means "this client cannot show
	 * this thing" — such clients are absent from that kind's row, never
	 * stubbed: a homepage stub for an incapable client is the
	 * homepage-fling outcome the design rejects.
	 */
	profile?: ClientTarget;
	feed?: ClientTarget;
	channel?: ClientTarget;
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
		// Profile + feed = farcaster.xyz's own username shape — the URL the
		// profile linktree's way out always used; signed-gated via the
		// client-level requiresSigned flag above (the fork's rule,
		// generalized: farcaster.xyz hides unsigned accounts' surfaces,
		// so its pills suppress for known-unsigned authors, fail-open).
		profile: { web: "https://farcaster.xyz/{username}" },
		feed: { web: "https://farcaster.xyz/{username}" },
		// Channel — VERIFIED against the open-source app
		// (github.com/farcasterxyz/client): useHandleDeepLink rewrites
		// farcaster:// → https://farcaster.xyz/ and resolveUniversalChannel
		// matches /~/channel/:channelKey onto the native Channel screen.
		// The ~/ is LOAD-BEARING: the bare form would resolve as a profile
		// for the user "channel". Android rides the intent:// form with the
		// web URL as Chrome's native fallback.
		channel: {
			web: "https://farcaster.xyz/~/channel/{channelId}",
			deeplink: {
				scheme: "farcaster://~/channel/{channelId}",
				androidPackage: "com.farcaster.mobile",
			},
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
	// WEB HAS NO CAST ROUTE (re-verified Oct 2026, source + live): the
	// quorum-desktop router (src/components/Router/Router.tsx) registers
	// /messages, /spaces, /discover, /bookmarks, /wallet and a bare
	// /farcaster whose FarcasterPage renders a literal "Coming soon" empty
	// state — no path or query params, no cast rendering anywhere. The web
	// beta now lives at app.quorummessenger.com (www is the marketing site,
	// title "Quilibrium") but its server 404s every deep path (/farcaster,
	// /feed), so deep links die at the edge — only the app root resolves.
	// The https href therefore stays an honest homepage stub and the scheme
	// is the only per-cast target. The Feed tab requires a Farcaster account
	// connected inside Quorum — without one the app lands on its sign-in
	// screen.
	// LIVE VERIFICATION: iOS device-tested — the pill opens Quorum directly
	// to the cast thread; Android is source-verified via the intent:// form
	// but not yet device-tested. Vendor release note: Quilibrium signs
	// release APKs with the debug keystore committed in their repo —
	// repo-derived, not binary-verified; expect a rotation at their Play
	// launch. Keystore SHA-256:
	// FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C
	{
		id: "quorum",
		title: "Quorum",
		logoUrl: "/logos/quorum.png",
		web: "https://www.quorummessenger.com/",
		deeplink: {
			scheme: "quorummobile://feed?castHashPrefix={fullHash}&username={username}",
			androidPackage: "com.quilibrium.quorummobile",
		},
		// Profile — SOURCE-VERIFIED (quorum-mobile app/(tabs)/feed/index.tsx
		// `initialProfile` → SocialFeedModal profile screen): profileFid
		// required, profileUsername optional. Channel — SOURCE-VERIFIED: the
		// feed route accepts channelKey and seeds the nav stack into the
		// channel screen; slug-shaped ids are used as-is. Both are
		// scheme-only with the homepage stub as href (the desktop build's
		// Farcaster surface is "Coming soon" — there is no profile/channel
		// web page), and coarse-only: phones only. Both need a Farcaster
		// account connected in-app. Package rotation warning: Quilibrium
		// signs release APKs with the debug keystore committed in their
		// repo — expect a package/keystore rotation at their Play launch,
		// and this entry is the ONE place to make it (the profile fork and
		// channel trio resolve through here).
		profile: {
			web: "https://www.quorummessenger.com/",
			deeplink: {
				scheme: "quorummobile://feed?profileFid={fid}&profileUsername={username}",
				androidPackage: "com.quilibrium.quorummobile",
			},
			pointer: "coarse",
		},
		// Feed — VERIFIED (Oct 2026, same source trail as the profile
		// target): the profileFid deep link seeds SocialFeedModal with a
		// profile screen (app/(tabs)/feed/index.tsx — no castHashPrefix ⇒
		// "the modal pushes a profile screen instead of a thread") and that
		// screen renders the user's CAST LIST: SocialFeedModal mounts
		// ProfileView, whose useFarcasterProfile({fid}) returns { author,
		// casts, fetchNextPage }. Profile and feed are one merged surface
		// in Quorum — identical templates, this comment covers
		// both. Caveat, quoted from the hook: "its user-casts feed includes
		// replies, which the profile filters out" — the list shows
		// top-level casts only; replies live one tap deeper in thread
		// screens. Same caveats as the profile target: scheme-only
		// (homepage-stub href), coarse-only, needs a Farcaster account
		// connected in-app.
		feed: {
			web: "https://www.quorummessenger.com/",
			deeplink: {
				scheme: "quorummobile://feed?profileFid={fid}&profileUsername={username}",
				androidPackage: "com.quilibrium.quorummobile",
			},
			pointer: "coarse",
		},
		channel: {
			web: "https://www.quorummessenger.com/",
			deeplink: {
				scheme: "quorummobile://feed?channelKey={channelId}",
				androidPackage: "com.quilibrium.quorummobile",
			},
			pointer: "coarse",
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
		// Channel — VERIFIED against the APK (io.dimension.firefly 1.1.44,
		// apkpure mirror): the navigator registers firefly://FarcasterChannel/{url}
		// and https://farcaster.xyz/~/channel/{url} onto ONE route whose
		// token is the channel slug (the sibling regex /~/channel/[\w\-]+
		// pins the charset), rendering the native ChannelDetail
		// (farcasterChannelId=…) screen. The web href is the owner-confirmed
		// channel/farcaster/{id} route (network infix is part of their path;
		// Vercel's bot checkpoint blocks curl verification).
		channel: {
			web: "https://firefly.social/channel/farcaster/{channelId}",
			deeplink: {
				scheme: "firefly://FarcasterChannel/{channelId}",
				androidPackage: "io.dimension.firefly",
			},
		},
		// Profile — VERIFIED (Oct 2026):
		// https://firefly.social/profile/farcaster/{username} — the same
		// network-infixed vocabulary as the cast and channel routes; the
		// iOS AASA (appID 7LFDZ96332.io.mask.Mask) claims /profile/*
		// explicitly. Live-checked through a JS-rendering reader (the
		// Vercel security checkpoint 403s/429s plain curl): TWO authors
		// resolve logged-out with full identity cards — zoo ("zoo (@zoo)
		// on Firefly") and decent-artlu ("Ultra (@decent-artlu) on
		// Firefly": avatar, handle, wallet, bio, follow counts) — the
		// latter despite signed:false, so Firefly applies NO signed rule
		// (unlike farcaster.xyz). The rendered card links its own handle
		// at the infix form — self-canonical, first-class in their code.
		// The crawl archive's numeric /profile/{internalId} form is a
		// separate surface: fids and usernames do NOT resolve there
		// (verified live). Every other candidate format verified empty:
		// /profile/{username}, /profile/{fid}, /u/, /user/, bare
		// /{username} all render generic shells. No verified profile
		// scheme — web-only (deeplink evidence, if any, waits for the
		// APK navigator).
		profile: {
			web: "https://firefly.social/profile/farcaster/{username}",
		},
		// Feed — VERIFIED (Oct 2026, owner): the /feed tab the profile
		// self-links is their cast-list surface; a logged-out crawler
		// sees only chrome (the web app's lists are client-side — the
		// cast route shows the same wall), which is why capture attempts
		// alone couldn't seed this. Owner device-checked the surface
		// signed-in and directed the merged-surface assignment: feed
		// rides the SAME profile URL, like farcaster.xyz.
		feed: {
			web: "https://firefly.social/profile/farcaster/{username}",
		},
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
		// Profile — VERIFIED (Oct 2026): owner-provided /u/ route,
		// source-verified against the open-source server
		// (backmeupplz/quilcast server/index.mjs: /^\/u\/([^/]{1,64})$/ →
		// getUser(username) → SSR shell titled "{display} (@{user}) on
		// Quilcast" with the bio as description) and live-checked
		// (quilcast.com/u/decent-artlu serves exactly that SSR meta for the
		// right profile). fine-only: the fork's assignment is Quilcast
		// DESKTOP / Quorum MOBILE. Channel: unknown.
		profile: {
			web: "https://quilcast.com/u/{username}",
			pointer: "fine",
		},
		// Feed — VERIFIED (Oct 2026): the SAME /u/ route — profile and feed
		// are one merged surface in Quilcast, like farcaster.xyz. Source:
		// backmeupplz/quilcast src/app.tsx — the Profile component
		// (useRoute: r0 === 'u') renders a Feed box with Casts/Replies
		// tabs: casts = /v2/farcaster/feed/user/casts kept to top-level
		// casts (keep={c => !c.parent_hash}), replies =
		// /v2/farcaster/feed/user/replies_and_recasts kept to replies
		// (keep={c => !!c.parent_hash}). Default tab is casts, so the
		// landing list shows top-level casts only — replies one tab away
		// (same shape as the Quorum caveat). Re-live-checked the same day:
		// quilcast.com/u/zoo SSRs "zoo (@zoo) on Quilcast" + the right
		// bio. Same template as the profile target, fine-only.
		feed: {
			web: "https://quilcast.com/u/{username}",
			pointer: "fine",
		},
	},
	// Per-cast format verified against fc-clients-cast-action
	// (github.com/artlu99/fc-clients-cast-action, src/lib/deeplink.ts):
	// frame castId hashes are always full-form, hence {fullHash}.
	// RE-VERIFIED live (Oct 2026): explorer.neynar.com has migrated to
	// dev.neynar.com/explorer — every identifier path 308s to
	// dev.neynar.com/explorer/search?q={ident}, which SSRs a per-object
	// title ("Cast 0x895ecc…") and client-renders the cast card
	// (neynarxyz/explorer: [identifier] page matches /^0x[a-f0-9]{40}$/
	// into NetworkResponse → NeynarCastCard). The pill keeps the original
	// URL — it still lands on the cast through the redirect. NO
	// profile/feed route exists: non-cast identifiers there
	// are search queries (a fid query titles "FID n" and ships no profile
	// data server-side — a search page, not a profile).
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
	// Profile + feed — VERIFIED (Oct 2026, owner): the owner surfaced
	// ?view=profile&profileFid={fid}&profileTab=casts by clicking the
	// signed-in app; live-checked logged-out through a JS-rendering
	// reader — TWO fids render the full surface for signed-out visitors:
	// 10215/zoo (banner, activity header, 7-day histogram, cast list with
	// text and per-cast signer-app rows) and 3319217/decent-artlu
	// (signed:false — renders fully, so Vibeshift applies NO signed
	// rule). Server-side corroboration: /share-image with the same
	// params renders a distinct PNG (50,914 B vs the 42,915-B default
	// card unknown params get), and the SSR payload carries a fc:miniapp
	// launch_frame button pointing at this exact URL — first-class in
	// their code. Merged surface per owner direction (the Firefly
	// pattern): profile and feed are the SAME URL; profileTab=casts is
	// pinned because the bare form's default tab is unverified. The app
	// is fid-keyed like its cast view ⇒ {fid}-gated. Other profileTab
	// values: unverified (no SSR vocabulary) — only the casts tab is
	// seeded. Web-only (no scheme evidence).
	{
		id: "vibeshift",
		title: "Vibeshift",
		logoUrl: "/logos/vibeshift.png",
		web: "https://vibeshift.onchain.cooking/?view=cast&castHash={fullHash}&castFid={fid}",
		profile: {
			web: "https://vibeshift.onchain.cooking/?view=profile&profileFid={fid}&profileTab=casts",
		},
		feed: {
			web: "https://vibeshift.onchain.cooking/?view=profile&profileFid={fid}&profileTab=casts",
		},
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
	// Profile route: none (linkcast.xyz/{username} 404s, Oct 2026) —
	// the product is the links feed, cast-kind only.
	{
		id: "linkcast",
		title: "Linkcast",
		logoUrl: "/logos/linkcast.svg",
		web: "https://linkcast.xyz/cast/{fullHashRaw}",
		requiresExternalLinks: true,
	},
	// OpenCaster is Arca Computer's AGPL web client for Hypersnap — the
	// community-operated Farcaster-data node (its worker proxies the
	// standard /v2/farcaster/* hub APIs to a fixed public node); forked
	// from Quorum Desktop, so the quorum entry's sibling. Per-cast format
	// VERIFIED against the open-source client
	// (github.com/arcacomputer/opencaster, hypersnap/src/lib/navigation.ts):
	// castPath() emits /cast/0x{40 lowercase hex} as THE canonical share
	// link — an exact cast lookup, unlike the /{author}/0x{8..40-hex} alias
	// form, whose short hashes resolve through a bounded history search
	// (≤500 recent receipts, first verified match; "An unresolved
	// author-scoped alias is never a canonical cast share link") — hence
	// {fullHash}. Re-verified live (Oct 2026): /cast/0x895ecc74… renders
	// zoo's cast logged-out ("omg so relevant!"). No signed rule: the
	// unsigned author's cast (decent-artlu/0xbb54368f) renders its
	// identity and per-cast share image. No native app — no
	// assetlinks.json/AASA (both serve the SPA catch-all), no custom
	// scheme; the repo's Electron config is the retained Quorum shell.
	// Web-only. Profile + feed — VERIFIED (source + live):
	// /profile/{username} is canonical (root /{username} aliases it;
	// /profile/{fid} is their stable form) and its casts tab IS the cast
	// list (getProfileFeed) — the merged surface, like farcaster.xyz;
	// /following is session-scoped, not a shareable feed. Channel —
	// VERIFIED (source + live): /channel/{channelId}, charset
	// ^[a-zA-Z0-9_-]{1,64}$ enforced in router and SSR worker alike;
	// /channel/farcaster SSRs "farcaster (/farcaster)". Caveat: cast
	// availability rides the Hypersnap node's history — a cast outside
	// it answers "This cast was not found on Hypersnap" no matter the
	// URL.
	{
		id: "opencaster",
		title: "Opencaster",
		logoUrl: "/logos/opencaster.svg",
		web: "https://opencaster.org/cast/{fullHash}",
		profile: { web: "https://opencaster.org/profile/{username}" },
		feed: { web: "https://opencaster.org/profile/{username}" },
		channel: { web: "https://opencaster.org/channel/{channelId}" },
	},
	// HomieHouse is a PWA client on the Farcaster network with a learning /
	// crypto-safety framing ("Learn, cast, and connect"); its bundle states
	// the backend outright: "Hypersnap is the backend API HomieHouse uses
	// to query social data". Domains: the miniapp manifest's
	// accountAssociation payload decodes to {"domain":"homiehouse.xyz"}
	// while its frame homeUrl lives at homiehouse.lol/mini/ask-homie — but
	// homiehouse.app serves the full app and is SELF-CANONICAL (canonical
	// + og:url on every verified route point back at .app), so the entry
	// uses .app.
	// Per-cast format VERIFIED (Oct 2026) in the app's own bundle (Next.js
	// chunks served from homiehouse.app): feed rows link
	// href={`/cast/${e.hash}?returnTo=…`} and the route is tracked via
	// data-cast-detail-ready. LIVE: the full-hash URL SSRs per-cast
	// metadata — title "zoo on HomieHouse", canonical/og:url to itself, a
	// per-cast OG generator at /api/og/cast?hash={fullHash} — and renders
	// the cast ("omg so relevant!", thread context, like/recast/reply
	// counts). The SHORT form /cast/0x895ecc74 answers 200 with GENERIC
	// metadata ("Cast | HomieHouse", homepage og:url): the server resolves
	// only the full 0x+40-hex form, hence {fullHash}.
	// Profile — VERIFIED (Oct 2026): /profile?user={username} — cast
	// pages' own ld+json author URLs point there, the router reads ?user=
	// on /profile, and the URL SSRs real per-user identity (og:type=
	// profile, profile:username, ld+json Person; zoo: "primus amanuensis
	// @qbase"). Logged-out, the body is their onboarding guide around the
	// profile preview ("Preview your existing profile and casts. Looking
	// up a username does not sign you in."). Feed target NOT added: the
	// cast list on that surface is not verifiable logged-out.
	// No deeplink: PWA only — the onboarding guide's install path is
	// Add-to-Home-Screen / browser install; no assetlinks.json (the path
	// serves the SPA shell), no store app, no custom scheme anywhere in
	// the bundle (only farcaster:// / rainbow:// wallet references).
	// No signed rule: the known-unsigned author's cast renders ("Ultra on
	// HomieHouse" with cast text). Not links-only: a general feed/learn/
	// ask client — the link-less gate canonical renders too. No channel
	// vocabulary exists in the bundle.
	{
		id: "homiehouse",
		title: "HomieHouse",
		logoUrl: "/logos/homiehouse.svg",
		web: "https://homiehouse.app/cast/{fullHash}",
		profile: {
			web: "https://homiehouse.app/profile?user={username}",
		},
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

/** The kind vocabulary in one place — track.ts's `r` blob validates
 * against this; renderers pass it, never a second enum. */
export const ROUTE_KINDS: readonly RouteKind[] = [
	"cast",
	"profile",
	"feed",
	"channel",
];

/**
 * The last-used client for a NON-CAST route kind, resolved against the
 * route's offered set: the kind's own slug when capable, else
 * the CAST slug when capable — FLAT inheritance, another kind's choice
 * never carries — else nothing (no banner, badgeless menu). Stale slugs
 * self-heal: resolution only ever returns members of `offered`.
 * Structural prefs on purpose: the registry stays dependency-free
 * (clients.ts's ClientPrefs satisfies this shape).
 */
export function resolveLastUsed(
	prefs: { slug?: string; kinds?: { profile?: string; feed?: string } },
	kind: "profile" | "feed",
	offered: ClientDefinition[],
): ClientDefinition | undefined {
	const own = prefs.kinds?.[kind];
	if (own !== undefined) {
		const hit = offered.find((client) => client.id === own);
		if (hit !== undefined) return hit;
	}
	if (prefs.slug === undefined) return undefined;
	return offered.find((client) => client.id === prefs.slug);
}

/**
 * The landing's read-only per-kind preference line: the
 * cookie carries per-kind slugs only the routes can see — one string
 * makes the system inspectable ("Casts: Quorum · Profiles: Firefly ·
 * Feeds: inherits casts → Quorum"). Mirrors flat resolution honestly:
 * an own-kind slug that names no ACTIVE client (removed target,
 * suspended kill switch) displays as the inheritance it would resolve
 * to, never a dead name. No cookie state at all ⇒ no line.
 */
export function kindSummary(
	prefs: { slug?: string; kinds?: { profile?: string; feed?: string } },
): string | undefined {
	const cast = findClient(prefs.slug);
	if (cast === undefined) return undefined;
	const kind = (slug: string | undefined): string => {
		const own = findClient(slug);
		return own !== undefined
			? own.title
			: `inherits casts → ${cast.title}`;
	};
	return `Casts: ${cast.title} · Profiles: ${kind(prefs.kinds?.profile)} · Feeds: ${kind(prefs.kinds?.feed)}`;
}

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

/**
 * What a route can offer a template: the kind's own identifiers. Cast
 * routes carry everything; user routes have no hash; channel routes only a
 * channelId. Templates referencing a placeholder these vars lack are
 * skipped via missingVars — that gate IS the capability filter for
 * placeholder-bearing targets.
 */
export interface TemplateVars {
	username?: string;
	/** Route-form hash, short or full, exactly as requested. */
	hash?: string;
	/** Full hash as resolved by Shim. */
	fullHash?: string;
	/** Author fid — optional; templates that need it are fid-gated. */
	fid?: number;
	/** Channel id (channel routes). */
	channelId?: string;
}

/** Placeholders a template may reference; everything but the first four is optional. */
const PLACEHOLDERS = [
	"username",
	"hash",
	"fullHash",
	"fullHashRaw",
	"fid",
	"channelId",
] as const;

/** {fullHashRaw} derives from {fullHash}: bare lowercase hex, no 0x prefix. */
function placeholderValue(
	name: (typeof PLACEHOLDERS)[number],
	vars: TemplateVars,
): string | undefined {
	if (name === "fullHashRaw") {
		return vars.fullHash?.replace(/^0x/i, "").toLowerCase();
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
 * Native click-time targets for a client's CAST target, resolved per cast.
 * Returned to the renderer as data attributes; the pill href stays the web
 * URL on every platform. When both are present the client script picks per
 * platform: Android uses `intent` (Chrome-native fallback), iOS and
 * other coarse-pointer devices use `scheme`.
 *
 * - `scheme`: raw custom scheme, attempted on mobile with the web URL
 *   as visibility-aware fallback (see DEEPLINK_SCRIPT).
 * - `intent`: Android intent:// URL when an androidPackage is set —
 *   Chrome natively falls back to the encoded web URL in that form.
 * - neither: the client is web-only.
 *
 * The ONE intent:// composer — the profile fork and the channel trio
 * resolve through {@link targetDeeplinkTargets} with their kind targets.
 */
export function deeplinkTargets(
	client: ClientDefinition,
	vars: TemplateVars,
): { scheme?: string; intent?: string } {
	if (!client.deeplink || !client.web) return {};
	return targetDeeplinkTargets(
		{ web: client.web, deeplink: client.deeplink },
		vars,
	);
}

/**
 * The shared composer for ANY target (cast or kind): scheme resolution +
 * the Android intent:// form with the resolved web URL as Chrome's native
 * fallback. Markup stays in the renderers — this returns data, and each
 * renderer emits attributes in its own established order.
 */
export function targetDeeplinkTargets(
	target: ClientTarget,
	vars: TemplateVars,
): { scheme?: string; intent?: string } {
	if (!target.deeplink) return {};
	const scheme = resolveTemplate(target.deeplink.scheme, vars);
	const sep = scheme.indexOf("://");
	if (target.deeplink.androidPackage && sep > 0) {
		const web = resolveTemplate(target.web, vars);
		return {
			scheme,
			intent: `intent://${scheme.slice(sep + 3)}#Intent;scheme=${scheme.slice(0, sep)};package=${target.deeplink.androidPackage};S.browser_fallback_url=${encodeURIComponent(web)};end`,
		};
	}
	return { scheme };
}

/**
 * A client's target for a route kind. `cast` assembles the EXISTING
 * web/deeplink fields (byte-stability for every current consumer); the
 * other kinds read their additive field.
 */
export function targetFor(
	client: ClientDefinition,
	kind: RouteKind,
): ClientTarget | undefined {
	if (kind === "cast") {
		return client.web === undefined
			? undefined
			: { web: client.web, deeplink: client.deeplink };
	}
	return client[kind];
}

/** Leading class-string for a target's pointer scope (`class="pill${…}"`). */
export function pointerClass(target: ClientTarget): string {
	return target.pointer === undefined ? "" : ` ${target.pointer}-only`;
}

/**
 * Clients offered on a NON-CAST route (the cast path stays
 * clientsForPage with its content gates): must have a target for the kind
 * whose placeholders these vars satisfy, and must pass the signed rule —
 * requiresSigned extends to every kind (the profile fork's farcaster
 * suppression, generalized), FAIL-OPEN: only a known signed:false
 * suppresses, and channel routes run no /signed check at all, so
 * everything fails open there. requiresExternalLinks deliberately does
 * NOT apply — it gates on cast embed data, which no other route has.
 * clientsForRoute itself is stateless: no cookie, no badge, no rank,
 * no beacons — the calling renderer adds the stateful layer
 * (profile/feed) or stays stateless (channel).
 */
export function clientsForRoute(
	kind: "profile" | "feed" | "channel",
	vars: TemplateVars,
	signed?: boolean | null,
): ClientDefinition[] {
	return CLIENTS.filter((client) => {
		const target = client[kind];
		if (target === undefined || !isActive(client)) return false;
		// The gate covers the SCHEME too, not just the web template: a
		// scheme-only target (quorum's entries) rides a placeholder-free
		// stub href, and an unresolved {fid}/{username} in a scheme would
		// ship literal braces into a native URL. (The cast path keeps its
		// web-only gate — cast routes always carry the hash fields, and its
		// rendered bytes are frozen.)
		const templates =
			target.deeplink === undefined
				? [target.web]
				: [target.web, target.deeplink.scheme];
		if (templates.some((tpl) => missingVars(tpl, vars).length > 0)) {
			return false;
		}
		return !(client.requiresSigned === true && signed === false);
	});
}
