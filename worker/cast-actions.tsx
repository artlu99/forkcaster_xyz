// The cast page's interactive client UI: the "Open in …" action row and
// the auto-open banner/overlay — the server-rendered halves that
// CLIENT_SCRIPT / DEEPLINK_SCRIPT / AUTO_SCRIPT (cast-scripts.ts) drive.
// Pure rendering: no fetches, no env.

import type { RankSnapshot } from "../scripts/client-rank-lib.ts";
import {
	type ClientDefinition,
	type ClientTarget,
	clientsForPage,
	clientsForRoute,
	findClient,
	resolveLastUsed,
	resolveTemplate,
	targetDeeplinkTargets,
	targetFor,
	type TemplateVars,
} from "./client-registry.ts";
import { type ClientPrefs, clientDelay } from "./clients.ts";
import { AUTO_SCRIPT, DEEPLINK_SCRIPT } from "./cast-scripts.ts";
import { escapeHtml } from "./shell.tsx";

// Exported for clients.test.ts (pill markup with/without native targets).
// `kind` parameterizes the pill for the non-cast rows (PLAN7 phase 2):
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
		`<a class="pill client-pill" href="${escapeHtml(href)}" data-client="${escapeHtml(client.id)}"${kindAttr}${native}>` +
		`<img class="pill-logo" src="${escapeHtml(client.logoUrl)}" alt="" width="16" height="16" />` +
		`${escapeHtml(client.title)}` +
		(isLast ? `<span class="pill-badge">last used</span>` : "") +
		`</a>`
	);
}

// The action row. Cast mode (no `route`): the pre-PLAN7 row — one pill
// per clientsForPage entry, signed/link gates, {fid} gating, rank order.
// Route mode (PLAN7 phase 2): offered = clientsForRoute(kind, vars,
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
	return `<p class="actions"${rowAttrs}>${pills}</p>${hasNative ? DEEPLINK_SCRIPT : ""}`;
}

// Auto-open flow: for a returning user with a last-used client.
// - unset: pausable countdown for the saved wait. The script replaces
//   this status with a link to the client.
// - on: LARGE abort overlay. The script redirects when the wait elapses
//   (immediately at 0).
// - off (or ?noredirect): status + two-way chip.
// Route mode (PLAN7 phase 2) resolves over the kind's offered set via
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
	if (!last?.web) return { html: "" };
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
