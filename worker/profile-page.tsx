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

import { UPSTREAM_TIMEOUT_MS } from "./cast-source.ts";
import { isImageUrl } from "./cast-data.ts";
import {
	getCastsAndReplies,
	getFidByUsername,
	getUserByFid,
	hUrl,
	getUsernameByFid,
	type ShimCast,
	type ShimUser,
} from "./shim.ts";
import { escapeHtml, shell } from "./shell.tsx";

/** Skeleton size — the timeline route's only knob is `limit` (no cursor). */
export const TIMELINE_LIMIT = 10;

/** Snippet clamp for skeleton rows — routing matter, not reading matter. */
const TEXT_CLAMP = 200;

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
	  }
	| { kind: "not-found" }
	| { kind: "unreachable" };

/**
 * Resolve once: /f (identity verdict) races the timeline (independent —
 * keyed by username); /user/{fid} follows the fid. Only the identity stage
 * can produce 404/503: a /f miss is shim's authoritative "no such username",
 * and a sparse /user shape (username null after the fid resolved) is shim
 * contradicting itself — paranoid parity, also not-found.
 */
export async function resolveProfile(
	username: string,
): Promise<ResolvedProfile> {
	const castsPromise = getCastsAndReplies(
		username,
		TIMELINE_LIMIT,
		AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
	);
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
	const timeline = await castsPromise;
	return {
		kind: "found",
		// Entity failure fails soft: a username-only card still proves identity.
		user: user ?? { fid, username },
		fid,
		casts: timeline.casts as ProfileCast[],
		timelineOk: timeline.ok,
	};
}

// --- HTML renderer -----------------------------------------------------------

// Stroke icons inlined (simple-icons is brand-only); fill=none + currentColor
// matches the frame's monochrome treatment at small sizes.
const ICON_ATTRS =
	'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const COPY_ICON = `<svg ${ICON_ATTRS} class="icon-copy"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
const CHECK_ICON = `<svg ${ICON_ATTRS} class="icon-check"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
const EXTERNAL_ICON = `<svg ${ICON_ATTRS} class="icon-external"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`;

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
.profile-explorer { color: var(--muted); font-size: 12px; text-decoration: none; display: inline-flex; align-items: center; gap: 3px; }
.profile-explorer:hover, .profile-explorer:focus-visible { color: var(--accent); }
.profile-explorer svg { width: 10px; height: 10px; }
.profile-casts { margin: 28px 0 0; }
.profile-casts h2 { font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 0 0 10px; }
.profile-cast { display: block; text-decoration: none; color: inherit; border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; margin: 0 0 8px; transition: border-color 0.15s ease; }
.profile-cast:hover, .profile-cast:focus-visible { border-color: var(--accent); }
.profile-cast-text { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.profile-cast-meta { color: var(--muted); font-size: 12px; margin: 6px 0 0; display: flex; flex-wrap: wrap; gap: 4px 12px; }
.profile-empty { color: var(--muted); font-size: 14px; }
.casts-page-head { margin: 8px 0 0; }
.casts-page-head .profile-handle a { color: var(--muted); text-decoration: none; }
.casts-page-head .profile-handle a:hover, .casts-page-head .profile-handle a:focus-visible { color: var(--accent); }
</style>`;

function formatDate(unixSeconds: number): string {
	const date = new Date(unixSeconds * 1000);
	if (Number.isNaN(date.getTime())) return "";
	return new Intl.DateTimeFormat("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
	}).format(date);
}

/** Collapse whitespace, clamp to the skeleton budget. */
function clampText(text: string | undefined): string {
	const flat = (text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > TEXT_CLAMP ? `${flat.slice(0, TEXT_CLAMP - 1)}…` : flat;
}

/** An address renders (truncated) only in honest shapes; garbage stays text. */
function isAddress(value: string): boolean {
	return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function addressFacts(address: string): string {
	const truncated = `${address.slice(0, 6)}…${address.slice(-4)}`;
	const code = `<code title="${escapeHtml(address)}">${escapeHtml(truncated)}</code>`;
	if (!isAddress(address)) return `<li class="profile-address">${code}</li>`;
	// Opinionated explorer: Basescan (the Farcaster-ecosystem chain), not
	// Etherscan — forkcaster picks one surface and stops.
	const explorer = `<a class="profile-explorer" href="https://basescan.org/address/${escapeHtml(address)}">Basescan${EXTERNAL_ICON}</a>`;
	const copy = `<button type="button" class="profile-copy" data-copy="${escapeHtml(address)}" aria-label="Copy address">${COPY_ICON}${CHECK_ICON}</button>`;
	return `<li class="profile-address">${code}${copy}${explorer}</li>`;
}

function skeletonList(handle: string, casts: ProfileCast[]): string {
	const rows: string[] = [];
	for (const cast of casts) {
		// No hash ⇒ unroutable — skip rather than render a dead row.
		if (!cast.hash) continue;
		const href = `/${encodeURIComponent(handle)}/${cast.hash}`;
		const text = clampText(cast.text);
		const markers: string[] = [];
		const date =
			typeof cast.timestamp === "number" ? formatDate(cast.timestamp) : "";
		if (date) markers.push(`<span>${escapeHtml(date)}</span>`);
		if (cast.parentCastId) markers.push("<span>↳ reply</span>");
		if (
			(cast.embeds ?? []).some(
				(embed) => typeof embed.url === "string" && isImageUrl(embed.url),
			)
		) {
			markers.push("<span>[image]</span>");
		}
		rows.push(`<a class="profile-cast" href="${escapeHtml(href)}">${
			text ? `<p class="profile-cast-text">${escapeHtml(text)}</p>` : ""
		}${
			markers.length > 0
				? `<p class="profile-cast-meta">${markers.join("")}</p>`
				: ""
		}</a>`);
	}
	if (rows.length === 0) return "";
	return `<section class="profile-casts"><h2>Recent casts</h2>${rows.join("\n")}</section>`;
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
	const { user, fid, casts, timelineOk } = profile;
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

	let timelineHtml: string;
	if (casts.length > 0) {
		timelineHtml = skeletonList(handle, casts);
	} else {
		// ok+empty = a real "no casts yet"; !ok = shim hiccup — never a 404.
		timelineHtml = `<p class="profile-empty">${
			timelineOk
				? "No casts yet."
				: "Recent casts are unavailable right now."
		}</p>`;
	}

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
<p class="actions"><a class="pill" href="https://farcaster.xyz/${escapeHtml(handle)}">Open on Farcaster</a></p>
${timelineHtml}`;

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
	body.farcaster = `https://farcaster.xyz/${handle}`;
	return { status: 200, body };
}

// --- Casts skeleton page (/{username}/casts-and-replies) ----------------------
//
// The farcaster.xyz URL-shape mirror, under the waypoint law: a list, not a
// feed. Fixed 3 rows, no identity card (no /user call — the entity is the
// profile's job), no JSON twin. The /f verdict and the fail-soft timeline
// semantics are identical to the profile route.

/** Fixed size — a list, not a feed; the timeline route has no cursor anyway. */
export const CASTS_PAGE_LIMIT = 3;

export type ResolvedCasts =
	| { kind: "found"; casts: ProfileCast[]; timelineOk: boolean }
	| { kind: "not-found" }
	| { kind: "unreachable" };

export async function resolveCastsPage(
	username: string,
): Promise<ResolvedCasts> {
	const castsPromise = getCastsAndReplies(
		username,
		CASTS_PAGE_LIMIT,
		AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
	);
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
	const timeline = await castsPromise;
	return {
		kind: "found",
		casts: timeline.casts as ProfileCast[],
		timelineOk: timeline.ok,
	};
}

export function renderCastsHtml(
	profile: ResolvedCasts,
	username: string,
	primaryOrigin?: string,
): { status: 200 | 404 | 503; html: string } {
	const key = `${username}/casts-and-replies`;
	if (profile.kind === "not-found") {
		return { status: 404, html: notFoundPage(username, key) };
	}
	if (profile.kind === "unreachable") {
		return { status: 503, html: unavailablePage(username, key) };
	}
	const { casts, timelineOk } = profile;
	const listHtml =
		casts.length > 0
			? skeletonList(username, casts)
			: `<p class="profile-empty">${
					timelineOk
						? "No casts yet."
						: "Recent casts are unavailable right now."
				}</p>`;
	const body = `
${PROFILE_STYLE}
<div class="casts-page-head">
<h1 class="profile-title">@${escapeHtml(username)}</h1>
<p class="profile-handle"><a href="/${encodeURIComponent(username)}">Profile</a> · <a href="https://farcaster.xyz/${escapeHtml(username)}">Open on Farcaster</a></p>
</div>
${listHtml}`;
	return {
		status: 200,
		html: shell(
			`${key} · forkcaster`,
			body,
			{
				ogTitle: `@${username} — casts and replies`,
				description: `Recent casts and replies from @${username} on Farcaster`,
			},
			// No client script: no address row, so nothing to copy.
			undefined,
			primaryOrigin
				? `${primaryOrigin}/${encodeURIComponent(username)}/casts-and-replies`
				: undefined,
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
