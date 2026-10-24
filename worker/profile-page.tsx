// Profile landing pages — resolve once, render twice (PLAN4).
//
// Waypoint law: identity is the page, lists are skeletons (never feeds),
// interaction lives in the clients. Concretely: the identity card surfaces
// exactly the hydrated entity shim /user/{fid} returns — empty-prone fields
// render nothing, never faked, and nothing beyond it is fetched — and the
// cast list is bare routing matter into the cast waypoints. No pills, no
// auto-open, no cookies, no telemetry; the only client script on the page
// is the copy-address helper.
//
// Identity verdict: shim /f/{username} (fid) — the canonical identity
// source, same seat as everywhere else. Entity (/user/{fid}) and timeline
// (/{username}/casts-and-replies) fail soft: decoration and content must
// not 404 a proven identity. Strict statuses (404 / 503 + Retry-After)
// apply to both variants — unlike casts, a profile has no fail-open
// content source when shim is unreachable.

import { renderToString } from "preact-render-to-string";
import { FarcasterEmbed } from "react-farcaster-embed";
import { UPSTREAM_TIMEOUT_MS } from "./cast-source.ts";
import {
	quoteHashesOf,
	STATS_ROW,
	toCastData,
	urlEmbedsOf,
	type UnfurlResult,
} from "./cast-data.ts";
import { hardenBlankTargets, unfurl } from "./cast-page.tsx";
import { LIVE_STATS_SCRIPT } from "./cast-scripts.ts";
import {
	getCastsAndReplies,
	getCastByHash,
	getFidByUsername,
	getSignedStatus,
	getUserByFid,
	hUrl,
	getUsernameByFid,
	type ShimCast,
	type ShimUser,
} from "./shim.ts";
import { escapeHtml, shell } from "./shell.tsx";

/** Skeleton size — the timeline route's only knob is `limit` (no cursor). */
export const TIMELINE_LIMIT = 10;

/** casts-and-replies rows add reply parenting on top of the canonical shape. */
type ProfileCast = ShimCast & {
	parentCastId?: { fid?: number; hash?: string };
};

export type ResolvedProfile =
	| {
			kind: "found";
			user: ShimUser;
			fid: number;
			casts: ProfileCast[];
			/** false when the timeline call failed — render "unavailable", not 404. */
			timelineOk: boolean;
			/** The ban signal (shim /signed/{fid}); null = unknown ⇒ fail open. */
			signed: boolean | null;
	  }
	| { kind: "not-found" }
	| { kind: "unreachable" };

/**
 * Resolve once: /f (identity verdict) fires in parallel with the timeline
 * when one is wanted; /user/{fid} and the signed check follow the fid. Only
 * the identity stage can produce 404/503. `timeline: false` (the
 * identity-card profile page) skips the timeline call entirely — the casts
 * page owns the list; the JSON twin and the casts page fetch it.
 * `signed: true` runs the ban signal (shim /signed/{fid}) — null (unknown)
 * fails open, exactly like the cast action row.
 */
export async function resolveProfile(
	username: string,
	opts: { timeline?: boolean; signed?: boolean } = {},
): Promise<ResolvedProfile> {
	const castsPromise = opts.timeline
		? getCastsAndReplies(
				username,
				TIMELINE_LIMIT,
				AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
			)
		: null;
	let fid: number | undefined;
	try {
		fid = await getFidByUsername(
			username,
			AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
		);
	} catch {
		return { kind: "unreachable" };
	}
	if (fid === undefined) return { kind: "not-found" };
	let user: ShimUser | undefined;
	try {
		user = await getUserByFid(fid, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS));
	} catch {
		user = undefined;
	}
	if (user !== undefined && user.username == null) {
		return { kind: "not-found" };
	}
	let signed: boolean | null = null;
	if (opts.signed) {
		// The ban signal rides the same trust seat as identity (shim).
		// getSignedStatus never throws; unknown (null) fails open.
		signed = await getSignedStatus(
			fid,
			AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
		);
	}
	const timeline = castsPromise ? await castsPromise : null;
	return {
		kind: "found",
		// Entity failure fails soft: a username-only card still proves identity.
		user: user ?? { fid, username },
		fid,
		casts: timeline ? (timeline.casts as ProfileCast[]) : [],
		timelineOk: timeline ? timeline.ok : true,
		signed,
	};
}

// --- HTML renderer -----------------------------------------------------------

// Stroke icons inlined (simple-icons is brand-only); fill=none + currentColor
// matches the frame's monochrome treatment at small sizes.
const ICON_ATTRS =
	'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const COPY_ICON = `<svg ${ICON_ATTRS} class="icon-copy"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
const CHECK_ICON = `<svg ${ICON_ATTRS} class="icon-check"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

/**
 * The one client script a profile ships: write the full address to the
 * clipboard on copy-button click (secure-context API with an execCommand
 * fallback), flip to the check mark briefly. ES5, fail-silent — same
 * contract as the cast page's inline scripts.
 */
export const COPY_SCRIPT = `<script>
(function () {
  var buttons = document.querySelectorAll("[data-copy]");
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", function () {
      var button = this;
      var value = button.getAttribute("data-copy");
      var done = function () {
        button.classList.add("profile-copied");
        setTimeout(function () {
          button.classList.remove("profile-copied");
        }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(done, function () {});
      } else {
        var area = document.createElement("textarea");
        area.value = value;
        area.setAttribute("readonly", "");
        area.style.position = "absolute";
        area.style.left = "-9999px";
        document.body.appendChild(area);
        area.select();
        try { document.execCommand("copy"); } catch (e) {}
        document.body.removeChild(area);
        done();
      }
    });
  }
})();
</script>`;

const PROFILE_STYLE = `<style>
.profile-card { display: flex; gap: 16px; align-items: flex-start; margin: 8px 0 0; }
.profile-avatar { width: 72px; height: 72px; border-radius: 16px; flex: none; }
.profile-avatar-fallback { display: flex; align-items: center; justify-content: center; background: var(--accent-soft); color: var(--accent); font-weight: 700; font-size: 30px; }
.profile-head { min-width: 0; }
.profile-title { font-size: 22px; font-weight: 700; margin: 0; line-height: 1.3; overflow-wrap: anywhere; }
.profile-handle { color: var(--muted); margin: 2px 0 0; }
.profile-bio { margin: 10px 0 0; font-size: 15px; overflow-wrap: anywhere; }
.profile-facts { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; color: var(--muted); font-size: 13px; }
.profile-facts code { font-size: 12px; }
.profile-address { display: inline-flex; align-items: center; gap: 6px; }
.profile-address code { overflow-wrap: anywhere; }
.profile-copy { background: none; border: 1px solid var(--line); border-radius: 6px; width: 22px; height: 22px; padding: 3px; cursor: pointer; color: var(--muted); display: inline-flex; align-items: center; justify-content: center; transition: border-color 0.15s ease, color 0.15s ease; }
.profile-copy:hover, .profile-copy:focus-visible { border-color: var(--accent); color: var(--accent); }
.profile-copy svg { width: 12px; height: 12px; }
.profile-copy .icon-check { display: none; }
.profile-copy.profile-copied .icon-copy { display: none; }
.profile-copy.profile-copied .icon-check { display: block; color: var(--accent); }
.profile-empty { color: var(--muted); font-size: 14px; }
/* Unsigned way out: both pills ship in the SSR HTML (byte-identical for
   every device — no UA sniffing); CSS picks by pointer class. pointer:none
   devices see both — a graceful default. */
@media (pointer: coarse) { .fine-only { display: none; } }
@media (pointer: fine) { .coarse-only { display: none; } }
.casts-page-head { margin: 8px 0 0; }
.casts-page-head .profile-handle a { color: var(--muted); text-decoration: none; }
.casts-page-head .profile-handle a:hover, .casts-page-head .profile-handle a:focus-visible { color: var(--accent); }
.casts-embeds { display: flex; flex-direction: column; gap: 14px; margin: 24px 0 0; }
</style>`;

/** An address renders (linked, truncated) only in honest shapes; garbage stays text. */
function isAddress(value: string): boolean {
	return /^0x[0-9a-fA-F]{40}$/.test(value);
}

// Hardcoded unsigned-client destinations (owner-directed) — NOT
// registry-driven; the unsigned way out is a profile-surface affordance.
// Quorum desktop keeps the homepage stub (the verified desktop target —
// source-verified profile deep links exist but are mobile-scheme-only and
// device-unverified, see below); Quilcast mobile uses the owner-provided
// /u/ profile route.
const QUORUM_DESKTOP_URL = "https://www.quorummessenger.com/";
const quilcastProfileUrl = (handle: string): string =>
	`https://quilcast.com/u/${encodeURIComponent(handle)}`;

function addressFacts(address: string): string {
	const truncated = `${address.slice(0, 6)}…${address.slice(-4)}`;
	if (!isAddress(address)) {
		return `<li class="profile-address"><code title="${escapeHtml(address)}">${escapeHtml(truncated)}</code></li>`;
	}
	// The truncated code IS the Basescan link (new window — an external
	// surface, so it never navigates away from the waypoint). Opinionated
	// explorer: Basescan (the Farcaster-ecosystem chain), not Etherscan.
	const linked = `<a href="https://basescan.org/address/${escapeHtml(address)}" target="_blank" rel="noopener"><code title="${escapeHtml(address)}">${escapeHtml(truncated)}</code></a>`;
	const copy = `<button type="button" class="profile-copy" data-copy="${escapeHtml(address)}" aria-label="Copy address">${COPY_ICON}${CHECK_ICON}</button>`;
	return `<li class="profile-address">${linked}${copy}</li>`;
}

function notFoundPage(username: string, key = username): string {
	return shell(
		`${key} · forkcaster`,
		`<p class="notice">Profile not found: @${escapeHtml(username)}. The username may be wrong or unregistered.</p>`,
	);
}

function unavailablePage(username: string, key = username): string {
	return shell(
		`${key} · forkcaster`,
		`<p class="notice">Profile data is temporarily unavailable. <a href="/${escapeHtml(username)}">Retry</a>.</p>`,
	);
}

/**
 * HTML: identity card (the whole hydrated entity) + routing skeleton.
 * Zero telemetry/personalization surface — the copy helper is the page's
 * only script. Lenient toward decoration, strict about identity: 404 for
 * a proven miss, 503 when shim is unreachable (no fail-open content source
 * for identity, unlike casts).
 */
export function renderProfileHtml(
	profile: ResolvedProfile,
	username: string,
	primaryOrigin?: string,
): { status: 200 | 404 | 503; html: string } {
	if (profile.kind === "not-found") {
		return { status: 404, html: notFoundPage(username) };
	}
	if (profile.kind === "unreachable") {
		return { status: 503, html: unavailablePage(username) };
	}
	const { user, fid } = profile;
	// Identity is proven by now, but keep the honest fallback chain anyway.
	const handle = user.username ?? username;
	const displayName = user.displayName ?? null;
	const title = displayName ? `${displayName} (@${handle})` : `@${handle}`;
	const bio = user.bio ? user.bio.replace(/\s+/g, " ").trim() : "";

	const avatar = user.pfpUrl
		? `<img class="profile-avatar" src="${escapeHtml(user.pfpUrl)}" alt="" />`
		: `<div class="profile-avatar profile-avatar-fallback" aria-hidden="true">${escapeHtml(handle.charAt(0).toUpperCase())}</div>`;

	const facts: string[] = [`<li>fid ${fid}</li>`];
	if (user.primaryAddress) facts.push(addressFacts(user.primaryAddress));

	// The way out depends on the ban signal: signed === false means the
	// account is read-only on farcaster.xyz — "Open on Farcaster" would be
	// futile, so unsigned visitors get the hardcoded non-signer clients
	// instead (Quorum on desktop — the flagship client for non-signers —
	// Quilcast on mobile). Both pills ship; CSS picks by pointer. Unknown
	// (shim down / no answer) fails open: Farcaster stays offered.
	//
	// Destinations are hardcoded (owner-directed), not registry-driven:
	// - Quorum desktop: the homepage stub — the verified desktop target
	//   (quorum-mobile registers quorummobile:// on iOS/Android only, and
	//   source-verified profile deep links exist but are device-unverified:
	//   quorummobile://feed?profileFid={fid}&profileUsername={username}
	//   seeds SocialFeedModal's nav stack with a profile screen;
	//   profileUsername is optional, fid is required — see
	//   app/(tabs)/feed/index.tsx initialProfile).
	// - Quilcast mobile: the owner-provided /u/ profile route.
	const actions =
		profile.signed === false
			? `<p class="actions">
<a class="pill fine-only" href="${QUORUM_DESKTOP_URL}">Open in Quorum</a>
<a class="pill coarse-only" href="${quilcastProfileUrl(handle)}">Open in Quilcast</a>
</p>
<p class="notice">This account hasn't signed the social smart contract — it is read-only on farcaster.xyz, so Farcaster is not offered here.</p>`
			: `<p class="actions"><a class="pill" href="https://farcaster.xyz/${escapeHtml(handle)}">Open on Farcaster</a></p>`;

	// Waypoint law, strict dial: the identity card IS the page — no cast
	// list here. The list lives on /{username}/casts-and-replies.
	const body = `
${PROFILE_STYLE}
<div class="profile-card">
${avatar}
<div class="profile-head">
<h1 class="profile-title">${escapeHtml(displayName ?? `@${handle}`)}</h1>
<p class="profile-handle">@${escapeHtml(handle)}</p>
${bio ? `<p class="profile-bio">${escapeHtml(bio)}</p>` : ""}
<ul class="profile-facts">${facts.join("")}</ul>
</div>
</div>
${actions}
<p class="actions"><a class="pill" href="/${encodeURIComponent(handle)}/casts-and-replies">Casts and replies</a></p>`;

	const og = {
		ogTitle: title,
		description: bio || `Casts from @${handle} on Farcaster`,
		...(user.pfpUrl ? { image: user.pfpUrl } : {}),
	};
	const canonicalUrl = primaryOrigin
		? `${primaryOrigin}/${encodeURIComponent(handle)}`
		: undefined;
	return {
		status: 200,
		html: shell(
			`${handle} · forkcaster`,
			body,
			og,
			COPY_SCRIPT,
			canonicalUrl,
			"profile",
		),
	};
}

// --- JSON renderer -----------------------------------------------------------

/**
 * Agent JSON twin (?format=json) — strict statuses like the cast JSON:
 * 404 when shim has no such profile, 503 + Retry-After when unreachable.
 * Availability-gated fields appear only when their data exists.
 */
export function renderProfileJson(
	profile: ResolvedProfile,
	username: string,
	origin: string,
): {
	status: 200 | 404 | 503;
	body: Record<string, unknown>;
	retryAfter?: "60";
} {
	if (profile.kind === "not-found") {
		return { status: 404, body: { error: "profile not found" } };
	}
	if (profile.kind === "unreachable") {
		return {
			status: 503,
			body: { error: "profile data temporarily unavailable" },
			retryAfter: "60",
		};
	}
	const { user, fid, casts, timelineOk } = profile;
	const handle = user.username ?? username;
	const body: Record<string, unknown> = { username: handle, fid };
	if (user.displayName) body.displayName = user.displayName;
	if (user.bio) body.bio = user.bio;
	if (user.pfpUrl) body.pfp = user.pfpUrl;
	if (user.primaryAddress) body.primaryAddress = user.primaryAddress;
	const rows = casts
		.filter((cast) => cast.hash)
		.map((cast) => ({
			hash: cast.hash,
			...(cast.text ? { text: cast.text } : {}),
			...(typeof cast.timestamp === "number"
				? { timestamp: new Date(cast.timestamp * 1000).toISOString() }
				: {}),
			url: `${origin}/${handle}/${cast.hash}`,
		}));
	if (rows.length > 0) body.casts = rows;
	if (!timelineOk) body.note = "timeline unavailable";
	// Same note contract as the cast JSON: signed === false is the only
	// trigger; unknown/failed fails open.
	if (profile.signed === false) {
		body.note =
			"account hasn't signed the social smart contract; the profile is read-only on farcaster.xyz";
	}
	body.farcaster = `https://farcaster.xyz/${handle}`;
	return { status: 200, body };
}

// --- Casts page (/{username}/casts-and-replies) -------------------------------
//
// The farcaster.xyz URL-shape mirror, and the ONE list surface: the profile
// is the identity card (no casts), this page renders each cast IN FULL —
// exactly the individual cast page's pipeline: react-farcaster-embed SSR,
// unfurl-enriched URL embeds (≤3 per cast), /h-hydrated quotes (≤3 per
// cast), blank-target hardening, live-stats slot per card (the stats
// script fills every slot). Shim's timeline rows carry no inline user, so
// the profile entity is attached as the author. The OG preview is IDENTICAL
// to the profile's (same card visual, deeper page); canonical/og:url stay
// on this page's own URL. No JSON twin — the link is omitted rather than
// advertise HTML. The /f verdict and the fail-soft timeline semantics are
// identical to the profile route.

export async function renderCastsHtml(
	profile: ResolvedProfile,
	username: string,
	primaryOrigin?: string,
	env?: { UNFURL?: Fetcher },
): Promise<{ status: 200 | 404 | 503; html: string }> {
	const key = `${username}/casts-and-replies`;
	if (profile.kind === "not-found") {
		return { status: 404, html: notFoundPage(username, key) };
	}
	if (profile.kind === "unreachable") {
		return { status: 503, html: unavailablePage(username, key) };
	}
	const { user, fid, casts, timelineOk, signed } = profile;
	const handle = user.username ?? username;
	const displayName = user.displayName ?? null;

	// Shim timeline rows are author-implied — attach the hydrated entity so
	// each card renders exactly like it does on its own cast page.
	const author: ShimCast["user"] = {
		fid,
		username: handle,
		displayName: displayName ?? undefined,
		pfpUrl: user.pfpUrl ?? undefined,
		bio: user.bio ?? undefined,
	};

	// Enrichment up front, allSettled: every failure degrades alone
	// (unfurl ⇒ hostname-only card, quotes ⇒ dropped) and never 404s a
	// proven identity.
	const unfurlJobs = casts.flatMap((cast) =>
		urlEmbedsOf(cast).map((u) => unfurl(u, env)),
	);
	const quoteJobs = casts.flatMap((cast) =>
		quoteHashesOf(cast).map((h) =>
			getCastByHash(h, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)),
		),
	);
	const unfurlResults = await Promise.allSettled(unfurlJobs);
	const quoteResults = await Promise.allSettled(quoteJobs);

	const cards: string[] = [];
	let unfurlIndex = 0;
	let quoteIndex = 0;
	for (const cast of casts) {
		// No hash ⇒ unroutable — skip rather than render a dead card.
		if (!cast.hash) continue;
		const unfurlMap = new Map<string, UnfurlResult | undefined>();
		for (const u of urlEmbedsOf(cast)) {
			const r = unfurlResults[unfurlIndex++];
			unfurlMap.set(u, r?.status === "fulfilled" ? r.value : undefined);
		}
		const quotes = quoteHashesOf(cast).map(() => {
			const r = quoteResults[quoteIndex++];
			return r?.status === "fulfilled" ? r.value : undefined;
		});
		try {
			const card = hardenBlankTargets(
				renderToString(
					(await FarcasterEmbed({
						username: handle,
						hash: cast.hash,
						castData: toCastData(
							{ ...cast, user: author },
							unfurlMap,
							quotes,
						),
					})) as never,
				),
				// Same stats slot the individual cast page ships — the
				// live-stats script fills every slot on the page.
			).replace(
				STATS_ROW,
				() =>
					`<div class="farcaster-embed-stats" data-username="${escapeHtml(handle)}" data-hash="${escapeHtml(cast.hash as string)}">`,
			);
			cards.push(card);
		} catch {
			// A broken card must never take the list down.
		}
	}

	const listHtml =
		cards.length > 0
			? `<section class="casts-embeds">${cards.join("\n")}</section>`
			: `<p class="profile-empty">${
					timelineOk
						? "No casts yet."
						: "Recent casts are unavailable right now."
				}</p>`;

	// Same ban-signal fork as the profile: unsigned ⇒ the hardcoded
	// non-signer clients in the head line (Quorum desktop / Quilcast
	// mobile), never Farcaster.
	const wayOut =
		signed === false
			? `<a class="fine-only" href="${QUORUM_DESKTOP_URL}">Open in Quorum</a> · <a class="coarse-only" href="${quilcastProfileUrl(handle)}">Open in Quilcast</a>`
			: `<a href="https://farcaster.xyz/${escapeHtml(handle)}">Open on Farcaster</a>`;

	const body = `
${PROFILE_STYLE}
<div class="casts-page-head">
<h1 class="profile-title">${escapeHtml(displayName ?? `@${handle}`)}</h1>
<p class="profile-handle">@${escapeHtml(handle)} · <a href="/${encodeURIComponent(handle)}">Profile</a> · ${wayOut}</p>
</div>
${signed === false ? `<p class="notice">This account hasn't signed the social smart contract — it is read-only on farcaster.xyz, so Farcaster is not offered here.</p>` : ""}
${listHtml}`;

	// OG preview identical to the profile's: same title/description/image.
	const og = {
		ogTitle: displayName ? `${displayName} (@${handle})` : `@${handle}`,
		description:
			(user.bio ? user.bio.replace(/\s+/g, " ").trim() : "") ||
			`Casts from @${handle} on Farcaster`,
		...(user.pfpUrl ? { image: user.pfpUrl } : {}),
	};
	const canonicalUrl = primaryOrigin
		? `${primaryOrigin}/${encodeURIComponent(handle)}/casts-and-replies`
		: undefined;
	return {
		status: 200,
		html: shell(
			`${key} · forkcaster`,
			body,
			og,
			// The live-stats script fills one slot per card; nothing else —
			// no pills, no telemetry, no auto-open on this surface.
			LIVE_STATS_SCRIPT,
			canonicalUrl,
			"profile",
			// No JSON twin — never advertise one.
			false,
		),
	};
}

// --- Warpcast legacy alias (/~/conversations/0x…) ------------------------------
//
// The purest waypoint in the family: no surface at all. Resolve the hash via
// shim /h (the quote-hydrator's call) and 302 to the canonical
// /{username}/{fullHash} cast waypoint.

export type ResolvedConversationAlias =
	| { kind: "found"; username: string; fullHash: string }
	| { kind: "not-found" }
	| { kind: "unreachable" };

export async function resolveConversationAlias(
	hash: string,
): Promise<ResolvedConversationAlias> {
	// /h answers misses at HTTP 200 ({"success":false}) — non-ok or a thrown
	// request means the service, not the cast, is the problem.
	let cast: ShimCast | undefined;
	try {
		const res = await fetch(hUrl(hash), {
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
		});
		if (!res.ok) return { kind: "unreachable" };
		const data = (await res.json().catch(() => undefined)) as
			| { success?: boolean; cast?: ShimCast | null }
			| undefined;
		cast = data?.cast ?? undefined;
	} catch {
		return { kind: "unreachable" };
	}
	if (!cast?.hash) return { kind: "not-found" };
	// The alias's single job is producing /{username}/{fullHash}: a
	// username-less cast falls back to shim /u/{fid}. A network failure there
	// is an outage (503 — the cast exists, we just can't route it); an
	// authoritative /u miss is a real dead end (404).
	let username: string | undefined = cast.user?.username ?? undefined;
	if (!username) {
		if (typeof cast.fid !== "number") return { kind: "not-found" };
		try {
			username =
				(await getUsernameByFid(
					cast.fid,
					AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
				)) ?? undefined;
		} catch {
			return { kind: "unreachable" };
		}
		if (!username) return { kind: "not-found" };
	}
	return { kind: "found", username, fullHash: cast.hash };
}
