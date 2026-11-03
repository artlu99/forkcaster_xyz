// The cast pages' interactive client UI: the client sheet (the drawer-style
// "Open in…" chooser — trigger + dialog, clientActionsHtml below) and the
// auto-open banner/overlay — the server-rendered halves that CLIENT_SCRIPT /
// DEEPLINK_SCRIPT / SHEET_SCRIPT / AUTO_SCRIPT (cast-scripts.ts) drive.
// Pure rendering: no fetches, no env.

import type { RankSnapshot } from "../scripts/client-rank-lib.ts";
import {
	type ClientDefinition,
	type ClientTarget,
	clientsForPage,
	clientsForRoute,
	findClient,
	resolveLastUsed,
	pointerClass,
	resolveTemplate,
	targetDeeplinkTargets,
	targetFor,
	type TemplateVars,
} from "./client-registry.ts";
import { type ClientPrefs, clientDelay } from "./clients.ts";
import { AUTO_SCRIPT, DEEPLINK_SCRIPT } from "./cast-scripts.ts";
import { escapeHtml } from "./shell.tsx";

// Exported for clients.test.ts (pill markup with/without native targets).
// `kind` parameterizes the pill for the non-cast rows:
// the target resolves from the client's profile/feed entry and the anchor
// carries data-kind for the client script's segment write. Absent (cast)
// = the existing fields, byte-identical markup.
export function clientPill(
	client: ClientDefinition,
	vars: TemplateVars,
	isLast: boolean,
	kind?: "profile" | "feed",
): string {
	const target = targetFor(client, kind ?? "cast") as ClientTarget;
	const href = resolveTemplate(target.web, vars);
	const targets = targetDeeplinkTargets(target, vars);
	const native =
		(targets.intent ? ` data-intent="${escapeHtml(targets.intent)}"` : "") +
		(targets.scheme ? ` data-scheme="${escapeHtml(targets.scheme)}"` : "");
	const kindAttr = kind === undefined ? "" : ` data-kind="${kind}"`;
	return (
		`<a class="pill client-pill${pointerClass(target)}" href="${escapeHtml(href)}" data-client="${escapeHtml(client.id)}"${kindAttr}${native}>` +
		`<img class="pill-logo" src="${escapeHtml(client.logoUrl)}" alt="" width="16" height="16" />` +
		`${escapeHtml(client.title)}` +
		(isLast ? `<span class="pill-badge">last used</span>` : "") +
		`</a>`
	);
}

// The client sheet's offered set. Cast mode (no `route`): one pill
// per clientsForPage entry, signed/link gates, {fid} gating, rank order.
// Route mode: offered = clientsForRoute(kind, vars,
// signed) — capability + the signed rule, fail-open — the row publishes
// data-kind and data-resolved (the badge's client, which the client
// script's first/switch/repeat compares against), and every pill carries
// data-kind. Rank ordering applies to both modes: reordered, never
// hidden — on kinds the client can serve.
export function clientActionsHtml(
	vars: TemplateVars,
	signed: boolean | null,
	lastClientId: string | undefined,
	rank?: RankSnapshot | null,
	externalLinks?: boolean,
	route?: { kind: "profile" | "feed"; resolvedId?: string },
): string {
	const last = findClient(route ? route.resolvedId : lastClientId);
	const offered = route
		? clientsForRoute(route.kind, vars, signed)
		: clientsForPage(signed === true, vars, externalLinks);
	const scoreById = new Map((rank?.rows ?? []).map((row) => [row.id, row.score]));
	const positionById = new Map(offered.map((client, i) => [client.id, i]));
	const ordered =
		scoreById.size === 0
			? offered
			: [...offered].sort(
					(a, b) =>
						(scoreById.get(b.id) ?? 0) - (scoreById.get(a.id) ?? 0) ||
						(positionById.get(a.id) ?? 0) - (positionById.get(b.id) ?? 0),
				);
	const pills = ordered
		.map((client) =>
			clientPill(client, vars, last !== undefined && client.id === last.id, route?.kind),
		)
		.join("\n");
	// The mobile deeplink script ships only when a rendered client
	// actually has a native target — zero bytes otherwise. Offered clients
	// always have the kind's target (the gate guarantees it), hence the
	// assertion.
	const hasNative = offered.some(
		(client) =>
			Object.keys(
				targetDeeplinkTargets(
					targetFor(client, route?.kind ?? "cast") as ClientTarget,
					vars,
				),
			).length > 0,
	);
	const rowAttrs = route
		? ` data-kind="${route.kind}"${route.resolvedId ? ` data-resolved="${escapeHtml(route.resolvedId)}"` : ""}`
		: "";
	// The client sheet: one trigger where the bare pill row used to be, and
	// a <dialog class="sheet"> carrying the pills byte-identically. The
	// hooks survive the relocation: the pills stay a.client-pill[data-client]
	// (CLIENT_SCRIPT records clicks document-wide; SHELL_PREP reads them for
	// its decision and stamps the badge); the in-sheet container keeps
	// class="actions" with its route attrs (AUTO_SCRIPT pauses a countdown
	// on pointerdown inside .actions; SHELL_PREP stamps data-resolved on
	// p.actions[data-kind]); the trigger row carries the same class, so
	// opening the chooser pauses a pending redirect too. The auto-open
	// toggle inside the sheet is THE one control (the on-page chip is
	// gone): SHELL_SCRIPT syncs its state from the local cookie and
	// SHEET_SCRIPT writes flips through POST /prefs. Without JS the dialog
	// never opens — shell()'s no-js CSS renders it as a plain block instead,
	// pills reachable, trigger and toggle hidden (nothing works there).
	if (ordered.length === 0) return "";
	// Copy names its object, kind-aware — trigger, sheet title, and the
	// profile/feed rows alike ("Open this cast in…"). SHELL_PREP's
	// resolution-first rewrite keys off the same markup, not the words.
	const noun =
		route?.kind === "profile" ? "profile" : route?.kind === "feed" ? "feed" : "cast";
	return chooserMarkup({
		count: ordered.length,
		pills,
		rowAttrs,
		hasNative,
		noun,
	});
}

/**
 * The chooser's two shapes, from already-computed pieces: two-or-more
 * offers get the trigger + <dialog class="sheet"> (the sheet earns its
 * keep as a chooser only when there is a choice); ONE offer gets the bare
 * pill row — one option never earns two taps (pre-sheet era markup,
 * byte-identical pills, route attrs intact; the stateful layer still
 * badges it and resolves auto-open, and native pills keep their
 * click-time script). Zero offers render nothing. Exported for
 * client-single-offer.test.ts: the real roster never shrinks to one
 * today, so the branch is pinned at this seam instead of behind a
 * registry mock (which would leak across bun's shared module cache).
 */
export function chooserMarkup(opts: {
	count: number;
	pills: string;
	rowAttrs: string;
	hasNative: boolean;
	noun: string;
}): string {
	if (opts.count === 0) return "";
	if (opts.count === 1) {
		return `<p class="actions"${opts.rowAttrs}>${opts.pills}</p>${opts.hasNative ? DEEPLINK_SCRIPT : ""}`;
	}
	const triggerRow =
		// The no-js → js swap rides HERE, not in the head: a synchronous
		// inline script before the sheet markup parses is equally
		// FOUC-proof, and pages without a sheet (channels pin "exactly one
		// script") ship no swap at all.
		`<script>document.documentElement.classList.replace("no-js","js")</script>` +
		`<p class="actions"><button class="pill sheet-trigger" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="fk-sheet" data-sheet-open>Open this ${opts.noun} in\u2026</button></p>`;
	const sheet =
		`<dialog class="sheet" id="fk-sheet" data-sheet aria-labelledby="fk-sheet-title">` +
		`<p class="sheet-title" id="fk-sheet-title">Open this ${opts.noun} in</p>` +
		`<p class="actions"${opts.rowAttrs}>${opts.pills}</p>` +
		`<label class="sheet-pref"><input type="checkbox" role="switch" data-sheet-auto /><span>Open automatically next time</span></label>` +
		`</dialog>`;
	return `${triggerRow}${sheet}${opts.hasNative ? DEEPLINK_SCRIPT : ""}`;
}

// Auto-open flow: for a returning user with a last-used client.
// - unset: pausable countdown for the saved wait. The script replaces
//   this status with a link to the client.
// - on: LARGE abort overlay. The script redirects when the wait elapses
//   (immediately at 0).
// - off (or ?noredirect): status + two-way chip.
// Route mode resolves over the kind's offered set via
// flat inheritance (resolveLastUsed) and emits data-auto-noun (the
// script's copy: "next profiles open in …") + data-auto-kind (the /t
// route blob). Cast mode: byte-identical to the pre-phase-2 banner.
export function autoOpenUi(
	prefs: ClientPrefs,
	signed: boolean | null,
	vars: TemplateVars,
	noredirect: boolean,
	externalLinks?: boolean,
	route?: { kind: "profile" | "feed"; noun: string },
): { html: string; script?: string } {
	let last: ClientDefinition | undefined;
	if (route !== undefined) {
		last = resolveLastUsed(
			prefs,
			route.kind,
			clientsForRoute(route.kind, vars, signed),
		);
	} else {
		if (prefs.slug === undefined) return { html: "" };
		last = clientsForPage(signed === true, vars, externalLinks).find(
			(c) => c.id === prefs.slug,
		);
	}
	if (last === undefined || !last.web) {
		// Idle chip: auto-open is armed but nothing resolves
		// for this route — the last-used client can't serve this kind, is
		// signed/link-gated out, or the cast lacks a needed placeholder.
		// Name the armed client in ONE server-rendered line instead of
		// silence; no script ships (nothing times out, nothing opens).
		// Only the armed state explains itself — off/noredirect keep
		// their own chips (or the pre-chip silence), and a slug that
		// names no ACTIVE client (stale/suspended) self-heals silently.
		if (prefs.auto === "on" && !noredirect) {
			const named = findClient(
				route !== undefined
					? (prefs.kinds?.[route.kind] ?? prefs.slug)
					: prefs.slug,
			);
			if (named?.web !== undefined) {
				return {
					html:
						`<div class="auto-banner" aria-live="polite" data-auto="idle">` +
						`<span class="auto-status">Auto-open: ${escapeHtml(named.title)} isn&#39;t offered here — pick below</span>` +
						`<a class="auto-settings" href="/">settings</a></div>`,
				};
			}
		}
		return { html: "" };
	}
	// Native-aware redirect: when the last-used client ships a deeplink,
	// the banner carries the resolved targets so AUTO_SCRIPT attempts the
	// app before falling back to the web href — for quorum that href is a
	// homepage stub, and a plain location.replace() would never open the
	// app (the deterministic "redirect lands on the website" bug). The
	// web href was checked above, so the target exists.
	const target = targetFor(last, route?.kind ?? "cast") as ClientTarget;
	const url = escapeHtml(resolveTemplate(target.web, vars));
	const name = escapeHtml(last.title);
	const delay = clientDelay(prefs);
	const targets = target.deeplink
		? targetDeeplinkTargets(target, vars)
		: {};
	const nativeMeta = targets.scheme
		? ` data-auto-scheme="${escapeHtml(targets.scheme)}"` +
			(targets.intent ? ` data-auto-intent="${escapeHtml(targets.intent)}"` : "")
		: "";
	const routeMeta = route
		? ` data-auto-noun="${route.noun}" data-auto-kind="${route.kind}"`
		: "";
	const meta = `data-auto-url="${url}" data-auto-client="${name}" data-auto-slug="${escapeHtml(last.id)}" data-auto-delay="${delay}"${nativeMeta}${routeMeta}`;
	const opening =
		delay === 0
			? `Opening <strong>${name}</strong> now`
			: `Opening <strong>${name}</strong> in <span class="auto-secs">${delay}</span>s`;
	const open = `<div class="auto-overlay" role="alert" data-auto="on" ${meta}>`;
	const banner = (status: string, mode: string) =>
		`<div class="auto-banner" aria-live="polite" data-auto="${mode}" ${meta}><span class="auto-status">${status}</span>`;
	// On: LARGE abort overlay. The script redirects when the wait elapses
	// (immediately at 0).
	if (!noredirect && prefs.auto === "on") {
		return {
			html:
				open +
				`<p class="auto-overlay-title">${opening}\u2026</p>` +
				`<p class="auto-overlay-actions"><button class="pill" data-auto-action="pause">Pause</button></p></div>`,
			script: AUTO_SCRIPT,
		};
	}
	// Unset: pausable countdown for the saved wait. The script replaces
	// this status with a link to the client.
	if (!noredirect && prefs.auto === undefined) {
		return {
			html:
				banner(`${opening} \u2192`, "unset") +
				`<button class="pill" data-auto-action="pause">Pause</button></div>`,
			script: AUTO_SCRIPT,
		};
	}
	// OFF state, or the ?noredirect escape: status + two-way chip.
	const status = noredirect
		? prefs.auto === "on"
			? "Auto-open: On \u2014 this page won't redirect"
			: "Auto-open: Off"
		: "Auto-open is off";
	const pressed = prefs.auto === "on" ? "true" : "false";
	const label = prefs.auto === "on" ? "On" : "Off";
	return {
		html:
			banner(status, noredirect ? "noredirect" : "off") +
			`<button class="pill auto-chip" data-auto-toggle aria-pressed="${pressed}" title="Toggle auto-open">Auto-open: ${label}</button>` +
			`<a class="auto-settings" href="/">settings</a></div>`,
		script: AUTO_SCRIPT,
	};
}
