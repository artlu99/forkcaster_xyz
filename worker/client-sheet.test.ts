/**
 * The client sheet — the drawer-style "Open in…" chooser that replaces the
 * always-visible pill row on the stateful surfaces (cast pages, profiles,
 * casts-and-replies). Channels stay stateless and keep the plain row.
 *
 * Contracts under test:
 *  - clientActionsHtml emits a sheet trigger row plus a <dialog class="sheet">
 *    carrying the byte-identical pills, the route attrs, and the auto-open
 *    toggle — the sheet toggle being THE one control (the on-page chip is
 *    gone).
 *  - SHEET_SCRIPT wires the sheet: showModal, backdrop close, cookie-synced
 *    toggle, POST /prefs, and the fk:auto event that hands the change to
 *    AUTO_SCRIPT's box.
 *  - AUTO_SCRIPT / SHELL_PREP lose the chip templates and gain the fk:auto
 *    seam (flip the pref → the box re-renders; flipping off cancels a
 *    pending redirect).
 *  - shell() ships the no-js class swap every sheet page needs: without JS,
 *    the sheet renders open as a plain block (the pills stay reachable),
 *    the trigger and the toggle disappear.
 *  - SHELL_SALT bumped: the markup/script change invalidates cached shells.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const { clientActionsHtml } = await import("./cast-actions.tsx");
const {
	AUTO_SCRIPT,
	SHEET_SCRIPT,
	SHELL_SCRIPT,
} = await import("./cast-scripts.ts");
const { shell } = await import("./shell.tsx");
const { SHELL_SALT } = await import("./edge-cache.ts");
import { LAST_CLIENT_COOKIE } from "./clients.ts";

const VARS = {
	username: "zoo",
	hash: "0x895ecc74",
	fullHash: "0x895ecc7415208bfb6105a8cb675f391f19cb9e2c",
	fid: 10215,
};

/** The dialog slice of a clientActionsHtml result (trigger excluded). */
function dialogOf(html: string): string {
	const start = html.indexOf('<dialog class="sheet"');
	expect(start).toBeGreaterThanOrEqual(0);
	const end = html.indexOf("</dialog>", start);
	return html.slice(start, end + "</dialog>".length);
}

describe("clientActionsHtml — sheet markup", () => {
	test("the no-js swap ships with the sheet markup, not the head", () => {
		const html = clientActionsHtml(VARS, false, undefined);
		// Synchronous inline swap BEFORE the sheet parses — FOUC-proof, and
		// sheet-less pages (channels pin "exactly one script") never see it.
		expect(html).toContain(
			'<script>document.documentElement.classList.replace("no-js","js")</script>',
		);
		expect(html.indexOf("classList.replace")).toBeLessThan(
			html.indexOf('<dialog class="sheet"'),
		);
	});

	test("emits a sheet trigger in place of the bare pill row", () => {
		const html = clientActionsHtml(VARS, false, undefined);
		expect(html).toContain(
			'<p class="actions"><button class="pill sheet-trigger" type="button" aria-haspopup="dialog"',
		);
		expect(html).toContain('data-sheet-open');
		expect(html).toContain(">Open in\u2026</button>");
	});

	test("wraps the pills in a dialog.sheet, pill markup byte-identical", () => {
		const html = clientActionsHtml(VARS, false, undefined);
		const dialog = dialogOf(html);
		// The pill anchor form the route tests assert byte-exactly.
		expect(dialog).toContain(
			`class="pill client-pill" href="https://firefly.social/post/farcaster/${VARS.fullHash}" data-client="firefly"`,
		);
		// The sheet's pill container keeps the row hooks: class="actions"
		// (AUTO_SCRIPT's pause-on-interaction walker) and the route attrs
		// (SHELL_PREP stamps data-resolved on p.actions[data-kind]).
		expect(dialog).toContain('<p class="actions">');
	});

	test("route mode keeps data-kind/data-resolved on the in-sheet row", () => {
		const html = clientActionsHtml(VARS, false, undefined, undefined, undefined, {
			kind: "profile",
			resolvedId: "firefly",
		});
		const dialog = dialogOf(html);
		expect(dialog).toContain('<p class="actions" data-kind="profile"');
		expect(dialog).toContain('data-resolved="firefly"');
	});

	test("carries the auto-open toggle — the one control (chip removed)", () => {
		const html = clientActionsHtml(VARS, false, undefined);
		const dialog = dialogOf(html);
		expect(dialog).toMatch(
			/<input type="checkbox" role="switch" data-sheet-auto( \/)?>/,
		);
		expect(dialog).toContain("Auto-open with last used");
		// No on-page chip anywhere in the emitted markup.
		expect(html).not.toContain("auto-chip");
		expect(html).not.toContain("data-auto-toggle");
	});

	test("DEEPLINK_SCRIPT still ships when a rendered pill has a native target", () => {
		// signed=true keeps farcaster (the one native-target client) offered.
		const html = clientActionsHtml(VARS, true, undefined);
		expect(html).toContain("pointer: coarse");
	});
});

describe("client sheet scripts", () => {
	test("SHEET_SCRIPT wires trigger, backdrop close, and the toggle", () => {
		expect(SHEET_SCRIPT).toContain("showModal");
		expect(SHEET_SCRIPT).toContain("data-sheet-open");
		expect(SHEET_SCRIPT).toContain("data-sheet-auto");
		expect(SHEET_SCRIPT).toContain("/prefs");
		expect(SHEET_SCRIPT).toContain("fk:auto");
		// The toggle's initial state syncs from the local cookie.
		expect(SHEET_SCRIPT).toContain(LAST_CLIENT_COOKIE);
		// ES5 body — ships to browsers untranspiled.
		expect(SHEET_SCRIPT).not.toMatch(/=>/);
	});

	test("the on-page chip templates are gone from the scripts", () => {
		for (const script of [AUTO_SCRIPT, SHELL_SCRIPT]) {
			expect(script).not.toContain("auto-chip");
			expect(script).not.toContain("data-auto-toggle");
		}
		// The off/noredirect STATUS lines stay (chip-free, settings link kept).
		expect(SHELL_SCRIPT).toContain("Auto-open is off");
		expect(SHELL_SCRIPT).toContain("this page won't redirect");
	});

	test("AUTO_SCRIPT honors fk:auto — the sheet toggle drives the box", () => {
		expect(AUTO_SCRIPT).toContain('addEventListener("fk:auto"');
		// The handler must cancel a pending redirect when the pref flips off.
		expect(AUTO_SCRIPT).toContain("cancelAll");
	});

	test("SHELL_PREP relabels the trigger with the resolved client", () => {
		expect(SHELL_SCRIPT).toContain('trigger.textContent = "Open in " + title');
		// Idle keeps the generic label (title stays "" there).
		expect(SHELL_SCRIPT).toContain("if (trigger && title)");
	});
});

describe("shell — no-js fallback for the sheet", () => {
	const page = shell("t", '<dialog class="sheet"></dialog>');

	test("html carries the no-js class (the swap rides the sheet markup)", () => {
		expect(page).toContain('<html lang="en" class="no-js">');
	});

	test("sheet CSS ships: motion, safe area, reduced motion, no-js block", () => {
		expect(page).toContain("dialog.sheet");
		expect(page).toContain("@starting-style");
		expect(page).toContain("allow-discrete");
		expect(page).toContain("env(safe-area-inset-bottom, 0px)");
		expect(page).toContain("prefers-reduced-motion");
		expect(page).toContain(".no-js dialog.sheet");
	});

	test("the exit choreography is @supports-gated; closed sheets hide hard", () => {
		// The allow-discrete display exit defers the UA's display:none for
		// the slide-out — without `overlay` (WebKit: bug 276727) the closed
		// sheet lingers rendered over the bottom action rows and eats their
		// taps. The full transition must ship only where `overlay` exists.
		expect(page).toContain("@supports (overlay: auto)");
		// Author-side closed-state hiding: restates the UA rule for engines
		// without <dialog> (unknown element would render inline otherwise).
		expect(page).toContain("dialog.sheet:not([open]) { display: none; }");
		// Equal-specificity cascade guard: the :not([open]) rule must come
		// BEFORE .no-js dialog.sheet, which must win to keep surfacing the
		// chooser as a plain block when JS never runs.
		expect(page.indexOf("dialog.sheet:not([open])")).toBeLessThan(
			page.indexOf(".no-js dialog.sheet"),
		);
	});
});

describe("shell cache invalidation", () => {
	test("SHELL_SALT bumped past the pre-sheet era", () => {
		expect(SHELL_SALT).not.toBe("v2");
	});
});
