// The cast page's interactive client UI: the "Open in …" action row and
// the auto-open banner/overlay — the server-rendered halves that
// CLIENT_SCRIPT / DEEPLINK_SCRIPT / AUTO_SCRIPT (cast-scripts.ts) drive.
// Pure rendering: no fetches, no env.

import type { RankSnapshot } from "../scripts/client-rank-lib.ts";
import {
	type ClientDefinition,
	clientsForPage,
	deeplinkTargets,
	findClient,
	resolveTemplate,
	type TemplateVars,
} from "./client-registry.ts";
import { type ClientPrefs, clientDelay } from "./clients.ts";
import { AUTO_SCRIPT, DEEPLINK_SCRIPT } from "./cast-scripts.ts";
import { escapeHtml } from "./shell.tsx";

// Exported for clients.test.ts (pill markup with/without native targets).
export function clientPill(
	client: ClientDefinition,
	vars: TemplateVars,
	isLast: boolean,
): string {
	const href = resolveTemplate(client.web as string, vars);
	const targets = deeplinkTargets(client, vars);
	const native =
		(targets.intent ? ` data-intent="${escapeHtml(targets.intent)}"` : "") +
		(targets.scheme ? ` data-scheme="${escapeHtml(targets.scheme)}"` : "");
	return (
		`<a class="pill client-pill" href="${escapeHtml(href)}" data-client="${escapeHtml(client.id)}"${native}>` +
		`<img class="pill-logo" src="${escapeHtml(client.logoUrl)}" alt="" width="16" height="16" />` +
		`${escapeHtml(client.title)}` +
		(isLast ? `<span class="pill-badge">last used</span>` : "") +
		`</a>`
	);
}

// The "Open in …" action row, rendered from the client registry. One
// pill per client; the pill whose id matches the last-used cookie
// carries the badge. Suppression (signed rule, unsatisfied placeholders
// like {fid}) is decided by clientsForPage; here signed is already
// reduced to pass/fail-open.
//
// Rank ordering (PLAN3): when a rank snapshot is available, pills are
// reordered by weighted score — a reordering, never a hiding (every
// offered client still renders), with registry order as the stable
// tiebreak so a quiet week can't scramble the row. Null snapshot ⇒
// registry order, byte-identical to the pre-rank render.
export function clientActionsHtml(
	vars: TemplateVars,
	signed: boolean,
	lastClientId: string | undefined,
	rank?: RankSnapshot | null,
): string {
	const last = findClient(lastClientId);
	const offered = clientsForPage(signed, vars);
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
			clientPill(client, vars, last !== undefined && client.id === last.id),
		)
		.join("\n");
	// The mobile deeplink script ships only when a rendered client
	// actually has a native target — zero bytes otherwise.
	const hasNative = offered.some(
		(client) => Object.keys(deeplinkTargets(client, vars)).length > 0,
	);
	return `<p class="actions">${pills}</p>${hasNative ? DEEPLINK_SCRIPT : ""}`;
}

// Auto-open flow: for a returning user with a last-used client.
// - unset: pausable countdown for the saved wait. The script replaces
//   this status with a link to the client.
// - on: LARGE abort overlay. The script redirects when the wait elapses
//   (immediately at 0).
// - off (or ?noredirect): status + two-way chip.
export function autoOpenUi(
	prefs: ClientPrefs,
	signed: boolean,
	vars: TemplateVars,
	noredirect: boolean,
): { html: string; script?: string } {
	if (!prefs.slug) return { html: "" };
	const last = clientsForPage(signed, vars).find((c) => c.id === prefs.slug);
	if (!last?.web) return { html: "" };
	const url = escapeHtml(resolveTemplate(last.web, vars));
	const name = escapeHtml(last.title);
	const delay = clientDelay(prefs);
	// Native-aware redirect: when the last-used client ships a deeplink,
	// the banner carries the resolved targets so AUTO_SCRIPT attempts the
	// app before falling back to the web href — for quorum that href is a
	// homepage stub, and a plain location.replace() would never open the
	// app (the deterministic "redirect lands on the website" bug).
	const targets = last.deeplink ? deeplinkTargets(last, vars) : {};
	const nativeMeta = targets.scheme
		? ` data-auto-scheme="${escapeHtml(targets.scheme)}"` +
			(targets.intent ? ` data-auto-intent="${escapeHtml(targets.intent)}"` : "")
		: "";
	const meta = `data-auto-url="${url}" data-auto-client="${name}" data-auto-slug="${escapeHtml(last.id)}" data-auto-delay="${delay}"${nativeMeta}`;
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
