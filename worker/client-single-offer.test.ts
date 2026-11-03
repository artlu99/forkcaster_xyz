/**
 * The chooser's shape contract (chooserMarkup in cast-actions.tsx): two
 * or more offers get the trigger + <dialog class="sheet">; ONE offer gets
 * the bare pill row — one option never earns a chooser, let alone two
 * taps. The function takes already-computed pieces, so the branch is
 * pinned here without touching the registry (whose mock would leak across
 * bun's shared module cache); the real roster never shrinks to one today.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const { chooserMarkup } = await import("./cast-actions.tsx");

const PILLS = '<a class="pill client-pill" href="https://solo.test/c/zoo/0xdef" data-client="solo">Solo</a>';
const ROW_ATTRS = ' data-kind="profile"';

describe("chooserMarkup — single offer", () => {
	test("one offer renders the bare pill row — no trigger, no sheet, no swap", () => {
		const html = chooserMarkup({
			count: 1,
			pills: PILLS,
			rowAttrs: ROW_ATTRS,
			hasNative: false,
			noun: "profile",
		});
		expect(html).toBe(
			`<p class="actions"${ROW_ATTRS}>${PILLS}</p>`,
		);
		expect(html).not.toContain("data-sheet-open");
		expect(html).not.toContain("<dialog");
		// No sheet on the page → nothing hides behind .no-js → no swap.
		expect(html).not.toContain("classList.replace");
		// No native target → no deeplink script.
		expect(html).not.toContain("pointer: coarse");
	});

	test("one native-target offer keeps the click-time script", () => {
		const html = chooserMarkup({
			count: 1,
			pills: PILLS,
			rowAttrs: "",
			hasNative: true,
			noun: "feed",
		});
		expect(html).toContain("pointer: coarse");
		expect(html).toContain("<p class=\"actions\">");
	});

	test("two offers still get the chooser, with kind-aware copy", () => {
		const html = chooserMarkup({
			count: 2,
			pills: PILLS,
			rowAttrs: "",
			hasNative: false,
			noun: "feed",
		});
		expect(html).toContain("data-sheet-open");
		expect(html).toContain(">Open this feed in\u2026</button>");
		expect(html).toContain('id="fk-sheet-title">Open this feed in</p>');
		// The swap rides BEFORE the sheet markup (FOUC-proof).
		expect(html.indexOf("classList.replace")).toBeLessThan(
			html.indexOf("<dialog"),
		);
	});

	test("zero offers render nothing", () => {
		expect(
			chooserMarkup({ count: 0, pills: PILLS, rowAttrs: "", hasNative: false, noun: "cast" }),
		).toBe("");
	});
});
