// Profile landing pages — resolve once, render twice.
//
// Waypoint law: identity is the page, lists are skeletons (never feeds),
// interaction lives in the clients. Concretely: the identity card surfaces
// exactly the hydrated entity shim /user/{fid} returns — empty-prone fields
// render nothing, never faked, and nothing beyond it is fetched — and the
// cast list is bare routing matter into the cast waypoints. The client
// layer is stateful: the menu is the way out, the badge
// marks the flat resolution (own kind slug, else the cast slug), and
// first/switch/repeat + the route kind flow through /t. The JSON twin
// stays personalization-free.
//
// Identity verdict: shim /f/{username} (fid) — the canonical identity
// source, same seat as everywhere else. Entity (/user/{fid}) and timeline
// (/{username}/casts-and-replies) fail soft: decoration and content must
// not 404 a proven identity. Strict statuses (404 / 503 + Retry-After)
// apply to both variants — unlike casts, a profile has no fail-open
// content source when shim is unreachable.
//
// Echo-the-valid-input: first-party links across the family carry the
// gate-validated route input, not the primary handle — shim resolves any
// resolvable alias (fname, ENS, basename) to the same fid, while
// /user/{fid} answers the NEWEST username proof, which can differ from
// what was typed. Identity law (2026-10-27 rethink of "canonical"): the
// fname is the account's PRIMARY handle — the first name — and any number
// of ENS names are attestations, rendered in parens after it (capped).
// Display, OG/canonical, external client targets, and the JSON twin carry
// the primary; first-party navigation keeps the visitor's own words.

import { renderToString } from "preact-render-to-string";
import { FarcasterEmbed } from "react-farcaster-embed";
import {
	rescueHashViaFarcasterTv,
	UPSTREAM_TIMEOUT_MS,
} from "./cast-source.ts";
import {
	primaryHandle,
	quoteTargetsOf,
	STATS_ROW,
	toCastData,
	urlEmbedsOf,
	type UnfurlResult,
} from "./cast-data.ts";
import {
	fetchQuote,
	hardenBlankTargets,
	relinkFarcasterAnchor,
	unfurl,
} from "./cast-page.tsx";
import {
	LIVE_STATS_SCRIPT,
	TRACK_SCRIPT,
	CLIENT_SCRIPT,
} from "./cast-scripts.ts";
import { clientActionsHtml, autoOpenUi } from "./cast-actions.tsx";
import {
	clientsForRoute,
	resolveLastUsed,
	type TemplateVars,
} from "./client-registry.ts";
import type { ClientPrefs } from "./clients.ts";
import type { RankSnapshot } from "../scripts/client-rank-lib.ts";
import {
	getCastsAndReplies,
	getFidByUsername,
	getSignedStatus,
	getUserByFid,
	hUrl,
	getUsernameByFid,
	warmShimHashIndex,
	type ShimCast,
	type ShimUser,
} from "./shim.ts";
import { collapseText, escapeHtml, shell } from "./shell.tsx";

/** Skeleton size — the timeline route's only knob is `limit` (no cursor). */
const TIMELINE_LIMIT = 10;

/**
 * Profile surfaces tolerate a longer shim window than casts: a slow
 * identity is a slower page, a failed identity is a 503 — and shim is
 * measured bursty (Oct 2026: /f hung >10s roughly 1-in-10 even for a hot
 * username, then recovered; /user regularly ran 4.5–5.6s against the old
 * 5s cast-route cap). One retry rides each load-bearing call; decoration
 * (/signed) stays single-shot.
 */
const PROFILE_TIMEOUT_MS = 8_000;

async function withOneRetry<T>(
	fn: (signal: AbortSignal) => Promise<T>,
	retryOnValue?: (value: T) => boolean,
): Promise<T> {
	try {
		const first = await fn(AbortSignal.timeout(PROFILE_TIMEOUT_MS));
		if (!retryOnValue?.(first)) return first;
	} catch {
		// Transport/timeout — retry below.
	}
	return fn(AbortSignal.timeout(PROFILE_TIMEOUT_MS));
}

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

// --- Identity law: primary handle + attestations -------------------------------

/**
 * Identity law (2026-10-27 rethink of "canonical"): the fname is the
 * account's PRIMARY handle — the first name — while any number of ENS
 * names (L1 or L2/basenames) are attestations. `primaryHandle` (cast-data)
 * resolves it; this file adds the attestation rendering.
 */

/** Attestations render in parens after the primary — the family cap: 3. */
const ATTESTATION_CAP = 3;

/**
 * The attestations to show: shim's proof-order list (deduped, primary
 * stripped), capped. Without the array (old shim/cold cache) the entity
 * username is still a verified proof name — surface it alone when it
 * differs from the primary. `cap` is Infinity for the JSON twin, which
 * carries the data uncapped.
 */
function attestationsOf(user: ShimUser, primary: string, cap = ATTESTATION_CAP): string[] {
	const raw = Array.isArray(user.attestations)
		? user.attestations
		: user.username && user.username !== primary
			? [user.username]
			: [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const name of raw) {
		if (typeof name !== "string" || name === primary || seen.has(name))
			continue;
		seen.add(name);
		out.push(name);
		if (out.length >= cap) break;
	}
	return out;
}

/**
 * The card's handle line: `@<strong>arfonzo</strong> (arfonzo.eth)` —
 * primary bold, attestations muted in parens. The parens are omitted when
 * there are none, so a legacy entity renders exactly its old line (plus
 * the bold primary).
 */
function handleLine(user: ShimUser, primary: string): string {
	const list = attestationsOf(user, primary)
		.map((name) => escapeHtml(name))
		.join(", ");
	return `@<strong>${escapeHtml(primary)}</strong>${list ? ` (${list})` : ""}`;
}

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
				AbortSignal.timeout(PROFILE_TIMEOUT_MS),
			)
		: null;
	let fid: number | undefined;
	try {
		fid = await withOneRetry((signal) =>
			getFidByUsername(username, signal),
		);
	} catch {
		return { kind: "unreachable" };
	}
	if (fid === undefined) return { kind: "not-found" };
	// Entity and ban signal are independent once the fid is known — fire
	// together. The entity retries (undefined = visible degradation); the
	// signed check fails open single-shot.
	const entityPromise = withOneRetry(
		(signal) => getUserByFid(fid, signal),
		(resolved) => resolved === undefined,
	);
	const signedPromise = opts.signed
		? getSignedStatus(fid, AbortSignal.timeout(PROFILE_TIMEOUT_MS))
		: null;
	let user: ShimUser | undefined;
	try {
		user = await entityPromise;
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
		signed = (await signedPromise) ?? null;
	}
	let timeline = castsPromise ? await castsPromise : null;
	// The timeline is content that fails soft — one retry on a failed call
	// makes the "unavailable" note rare instead of routine.
	if (timeline && !timeline.ok) {
		timeline = await getCastsAndReplies(
			username,
			TIMELINE_LIMIT,
			AbortSignal.timeout(PROFILE_TIMEOUT_MS),
		).catch(() => timeline);
	}
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
 * The copy-address helper: write the full address to the
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
/* The primary (fname) reads as the identity; attestations stay muted. */
.profile-handle strong { color: var(--ink); font-weight: 600; }
.profile-bio { margin: 10px 0 0; font-size: 15px; overflow-wrap: anywhere; }
.profile-bio a { color: var(--accent); text-decoration: none; }
.profile-bio a:hover, .profile-bio a:focus-visible { text-decoration: underline; }
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
/* Pointer-class pill scoping lives in the shared shell stylesheet. */
.casts-page-head { margin: 8px 0 0; }
.casts-page-head .profile-handle a { color: var(--muted); text-decoration: none; }
.casts-page-head .profile-handle a:hover, .casts-page-head .profile-handle a:focus-visible { color: var(--accent); }
.casts-embeds { display: flex; flex-direction: column; gap: 14px; margin: 24px 0 0; }
</style>`;

/** An address renders (linked, truncated) only in honest shapes; garbage stays text. */
function isAddress(value: string): boolean {
	return /^0x[0-9a-fA-F]{40}$/.test(value);
}

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
 * HTML: identity card (the whole hydrated entity) + routing skeleton,
 * plus the stateful client layer (menu, badge, banner).
 * The JSON twin (?format=json) stays cookie-free. Lenient toward
 * decoration, strict about identity: 404 for a proven miss, 503 when shim
 * is unreachable (no fail-open content source for identity, unlike casts).
 */
/**
 * Linkify explicit http(s) URLs in the collapsed bio — the one approved
 * exception to the plain-text bio (owner request). Everything else stays
 * inert escaped text: @mentions/#channels are graph features and remain
 * plain. Trailing punctuation (.,;:!?)"' etc.) is not part of the link —
 * bios end sentences with URLs. Every emitted character is escaped; the
 * URL is both the href and its own visible text.
 */
function renderBio(bio: string): string {
	const flat = bio.replace(/\s+/g, " ").trim();
	return flat
		.split(/(https?:\/\/\S+)/)
		.map((segment, index) => {
			if (index % 2 === 0 || segment === "") return escapeHtml(segment);
			// URL segment: peel trailing punctuation off into plain text.
			const trimmed = segment.replace(/[.,;:!?)\]}'"]+$/, "");
			const suffix = segment.slice(trimmed.length);
			return `<a href="${escapeHtml(trimmed)}" target="_blank" rel="noopener">${escapeHtml(trimmed)}</a>${escapeHtml(suffix)}`;
		})
		.join("");
}

export function renderProfileHtml(
	profile: ResolvedProfile,
	username: string,
	primaryOrigin?: string,
	prefs: ClientPrefs = {},
	rank?: RankSnapshot | null,
	noredirect = false,
): { status: 200 | 404 | 503; html: string } {
	if (profile.kind === "not-found") {
		return { status: 404, html: notFoundPage(username) };
	}
	if (profile.kind === "unreachable") {
		return { status: 503, html: unavailablePage(username) };
	}
	const { user, fid } = profile;
	// Identity law: primary = fname, falling back to the newest-proof
	// username (old shim/cold cache) and the validated route input. The
	// fallback chain stays honest — nothing is faked when shim answers.
	const primary = primaryHandle(user, username);
	const displayName = user.displayName ?? null;
	const title = displayName ? `${displayName} (@${primary})` : `@${primary}`;
	const bio = collapseText(user.bio);

	const avatar = user.pfpUrl
		? `<img class="profile-avatar" src="${escapeHtml(user.pfpUrl)}" alt="" />`
		: `<div class="profile-avatar profile-avatar-fallback" aria-hidden="true">${escapeHtml(primary.charAt(0).toUpperCase())}</div>`;

	const facts: string[] = [`<li>fid ${fid}</li>`];
	if (user.primaryAddress) facts.push(addressFacts(user.primaryAddress));

	// The stateful layer: the menu IS the way out —
	// offered = profile-capable clients (farcaster suppressed for
	// known-unsigned via requiresSigned, fail-open; unknown fails open and
	// offers it). The badge and the banner follow the flat resolution:
	// the kind's own slug, else the cast slug, else nothing (badgeless
	// menu, no banner). Registry order without a rank snapshot.
	const vars: TemplateVars = { username: primary, fid };
	const resolved = resolveLastUsed(
		prefs,
		"profile",
		clientsForRoute("profile", vars, profile.signed),
	);
	const menu = clientActionsHtml(
		vars,
		profile.signed,
		resolved?.id,
		rank,
		undefined,
		{ kind: "profile", resolvedId: resolved?.id },
	);
	const auto = autoOpenUi(prefs, profile.signed, vars, noredirect, undefined, {
		kind: "profile",
		noun: "profiles",
	});
	const notice =
		profile.signed === false
			? `<p class="notice">This account hasn't signed the social smart contract — it is read-only on farcaster.xyz, so Farcaster is not offered here.</p>`
			: "";

	// Waypoint law, strict dial: the identity card IS the page — no cast
	// list here. The list lives on /{username}/casts-and-replies, and the
	// pill echoes the validated input (echo-the-valid-input, see header).
	const body = `
${PROFILE_STYLE}
${auto.html}
<div class="profile-card">
${avatar}
<div class="profile-head">
<h1 class="profile-title">${escapeHtml(displayName ?? `@${primary}`)}</h1>
<p class="profile-handle">${handleLine(user, primary)}</p>
${bio ? `<p class="profile-bio">${renderBio(bio)}</p>` : ""}
<ul class="profile-facts">${facts.join("")}</ul>
</div>
</div>
${menu}
${notice}
<p class="actions"><a class="pill" href="/${encodeURIComponent(username)}/casts-and-replies">Casts and replies</a></p>`;

	const og = {
		ogTitle: title,
		description: bio || `Casts from @${primary} on Farcaster`,
		...(user.pfpUrl ? { image: user.pfpUrl } : {}),
	};
	const canonicalUrl = primaryOrigin
		? `${primaryOrigin}/${encodeURIComponent(primary)}`
		: undefined;
	return {
		status: 200,
		html: shell(
			`${primary} · forkcaster`,
			body,
			og,
			// Copy helper + the stateful layer's scripts (telemetry __fk, the
			// cookie writer, auto-open when a banner rendered). DEEPLINK_SCRIPT
			// rides inside the menu row when any pill has a native target.
			`${TRACK_SCRIPT}${CLIENT_SCRIPT}${COPY_SCRIPT}${auto.script ?? ""}`,
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
	const primary = primaryHandle(user, username);
	const attestations = attestationsOf(user, primary, Infinity);
	const body: Record<string, unknown> = { username: primary, fid };
	if (attestations.length > 0) body.attestations = attestations;
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
			url: `${origin}/${primary}/${cast.hash}`,
		}));
	if (rows.length > 0) body.casts = rows;
	if (!timelineOk) body.note = "timeline unavailable";
	// Same note contract as the cast JSON: signed === false is the only
	// trigger; unknown/failed fails open.
	if (profile.signed === false) {
		body.note =
			"account hasn't signed the social smart contract; the profile is read-only on farcaster.xyz";
	}
	body.farcaster = `https://farcaster.xyz/${primary}`;
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
	prefs: ClientPrefs = {},
	rank?: RankSnapshot | null,
	noredirect = false,
): Promise<{ status: 200 | 404 | 503; html: string }> {
	const key = `${username}/casts-and-replies`;
	if (profile.kind === "not-found") {
		return { status: 404, html: notFoundPage(username, key) };
	}
	if (profile.kind === "unreachable") {
		return { status: 503, html: unavailablePage(username, key) };
	}
	const { user, fid, casts, timelineOk, signed } = profile;
	const primary = primaryHandle(user, username);
	const displayName = user.displayName ?? null;

	// Shim timeline rows are author-implied — attach the hydrated entity so
	// each card renders exactly like it does on its own cast page. The
	// author handle is the primary (identity law), so embed cards link the
	// fname everywhere they surface it.
	const author: ShimCast["user"] = {
		fid,
		username: primary,
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
		quoteTargetsOf(cast).map((t) => fetchQuote(t)),
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
		const quotes = quoteTargetsOf(cast).map(() => {
			const r = quoteResults[quoteIndex++];
			return r?.status === "fulfilled" ? r.value : undefined;
		});
		try {
			// Same stats slot the individual cast page ships — the
			// live-stats script fills every slot on the page. For a proven
			// unsigned author the slot is flagged (data-local): the
			// farcaster.xyz cast URL is dead for them, so the script writes
			// local waypoints; unknown signedness fails open and the flag
			// never ships.
			const local = signed === false;
			const statsSlot = `<div class="farcaster-embed-stats"${local ? ' data-local="1"' : ""} data-username="${escapeHtml(primary)}" data-hash="${escapeHtml(cast.hash as string)}">`;
			const card = hardenBlankTargets(
				renderToString(
					(await FarcasterEmbed({
						username: primary,
						hash: cast.hash,
						castData: toCastData(
							{ ...cast, user: author },
							unfurlMap,
							quotes,
						),
					})) as never,
				),
			).replace(STATS_ROW, () => statsSlot);
			cards.push(
				local
					? relinkFarcasterAnchor(
							card,
							// First-party link ⇒ echoes the validated input.
							`/${encodeURIComponent(username)}/${cast.hash}`,
						)
					: card,
			);
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

	// The stateful layer: the feed row + banner resolve over the feed
	// kind — farcaster + quorum are the seeded feed targets (quorum
	// coarse-only/scheme-only; unsigned suppresses farcaster entirely
	// and the notice explains). Flat inheritance from the cast slug.
	const vars: TemplateVars = { username: primary, fid };
	const resolved = resolveLastUsed(
		prefs,
		"feed",
		clientsForRoute("feed", vars, signed),
	);
	const menu = clientActionsHtml(vars, signed, resolved?.id, rank, undefined, {
		kind: "feed",
		resolvedId: resolved?.id,
	});
	const auto = autoOpenUi(prefs, signed, vars, noredirect, undefined, {
		kind: "feed",
		noun: "feeds",
	});
	const notice =
		signed === false
			? `<p class="notice">This account hasn't signed the social smart contract — it is read-only on farcaster.xyz, so Farcaster is not offered here.</p>`
			: "";

	// Echo-the-valid-input (see header): the back-link echoes the input,
	// the visible @handle below carries the primary (identity law).
	const body = `
${PROFILE_STYLE}
${auto.html}
<div class="casts-page-head">
<h1 class="profile-title">${escapeHtml(displayName ?? `@${primary}`)}</h1>
<p class="profile-handle"><a href="/${encodeURIComponent(username)}">Profile</a></p>
</div>
${menu}
${notice}
${listHtml}`;

	// OG preview identical to the profile's: same title/description/image.
	const og = {
		ogTitle: displayName ? `${displayName} (@${primary})` : `@${primary}`,
		description:
			(user.bio ? user.bio.replace(/\s+/g, " ").trim() : "") ||
			`Casts from @${primary} on Farcaster`,
		...(user.pfpUrl ? { image: user.pfpUrl } : {}),
	};
	const canonicalUrl = primaryOrigin
		? `${primaryOrigin}/${encodeURIComponent(primary)}/casts-and-replies`
		: undefined;
	return {
		status: 200,
		html: shell(
			`${key} · forkcaster`,
			body,
			og,
			// Live-stats fills one slot per card; the stateful layer adds the
			// telemetry helper + cookie writer; auto-open rides the banner.
			// DEEPLINK_SCRIPT ships inside the feed row when its pill has a
			// native target.
			`${TRACK_SCRIPT}${CLIENT_SCRIPT}${LIVE_STATS_SCRIPT}${auto.script ?? ""}`,
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
// /{username}/{fullHash} cast waypoint. /h is a partial index (kept-warm
// fids only), so a cold hash 404s while the cast very much exists — the
// farcaster.tv hash-only rescue (cast-source.ts) covers that gap, and a
// rescued alias warms shim's index for every visitor after the first.

export type ResolvedConversationAlias =
	| { kind: "found"; username: string; fullHash: string }
	| { kind: "not-found" }
	| { kind: "unreachable" };

export async function resolveConversationAlias(
	hash: string,
	opts?: { waitUntil?: (p: Promise<unknown>) => void },
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
	// The tail's invariant, typed the ShimLookup-found way: both paths
	// below deliver a cast whose hash is present — shim's via the guard,
	// the rescue's by construction (rescued.fullHash: string). ShimCast
	// stays spec-faithful (`hash?: string` — presence-optional, never
	// null when present; the spec's generator marks required/nullable
	// explicitly), so the guarantee is carried HERE, not by weakening
	// the wire type.
	let found: ShimCast & { hash: string };
	if (!cast?.hash) {
		// Cold index, not a verdict: rescue via farcaster.tv's hash-only
		// route. Only ITS miss is authoritative (it resolves the live
		// chain); a transport failure stays unknown ⇒ 503. A rescue warms
		// shim's index fire-and-forget — the redirect never waits on it.
		const rescued = await rescueHashViaFarcasterTv(hash);
		if (rescued.kind === "error") return { kind: "unreachable" };
		if (rescued.kind === "miss") return { kind: "not-found" };
		opts?.waitUntil?.(warmShimHashIndex(rescued.fid));
		found = {
			fid: rescued.fid,
			hash: rescued.fullHash,
			// farcaster.tv's username is the Warpcast handle — the
			// fname-primary shape the tail below expects; absent → /u.
			user: rescued.username
				? { fid: rescued.fid, username: rescued.username }
				: undefined,
		};
	} else {
		// The guard pinned cast.hash truthy; the spread restates it so
		// the object meets the found shape (TS keeps property narrowing
		// on accesses, not on the parent's assignability).
		found = { ...cast, hash: cast.hash };
	}
	// The tail's invariant, typed the ShimLookup-found way: both paths
	// deliver a cast whose hash is present — shim's via the guard above,
	// the rescue's by construction (rescued.fullHash: string). ShimCast
	// stays spec-faithful (`hash?: string` — presence-optional, never
	// null; the spec's generator marks required/nullable explicitly), so
	// the guarantee is carried HERE, not by weakening the wire type.
	// The alias's single job is producing /{username}/{fullHash}: the
	// PRIMARY handle (identity law — fname first) when the cast carries a
	// user, else shim /u/{fid} (now fname-first itself). A network failure
	// there is an outage (503 — the cast exists, we just can't route it);
	// an authoritative /u miss is a real dead end (404).
	let username: string | undefined =
		found.user?.fname ?? found.user?.username ?? undefined;
	if (!username) {
		if (typeof found.fid !== "number") return { kind: "not-found" };
		try {
			username =
				(await getUsernameByFid(
					found.fid,
					AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
				)) ?? undefined;
		} catch {
			return { kind: "unreachable" };
		}
		if (!username) return { kind: "not-found" };
	}
	return { kind: "found", username, fullHash: found.hash };
}
