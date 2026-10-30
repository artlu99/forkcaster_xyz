/**
 * shell-state fixtures — the serialized auto-open decision, tested as the
 * browser will run it (direct import; the script embeds the same function
 * via toString). Ported-semantics checks against parseClientCookie/
 * autoOpenUi: bare slug = unset, %7C tolerated, garbage segments ignored,
 * kind segments ignored on casts, idle only in the arming state.
 */
import { describe, expect, test } from "bun:test";

import { shellAutoDecision, type ShellPill } from "./shell-state.ts";

const PILLS: ShellPill[] = [
	{
		slug: "zoo",
		url: "https://farcaster.xyz/zoo/0xabc",
		scheme: "farcaster://zoo/0xabc",
		intent: "intent://zoo/0xabc#Intent;scheme=farcaster;end",
	},
	{ slug: "firefly", url: "https://firefly.social/post/farcaster/0xabc", scheme: "", intent: "" },
];

describe("cookie parsing (ES5 twin of parseClientCookie)", () => {
	test("no cookie ⇒ null", () => {
		expect(shellAutoDecision(undefined, PILLS, false)).toBeNull();
		expect(shellAutoDecision("", PILLS, false)).toBeNull();
	});

	test("bare slug = unset arming, default delay 5", () => {
		const d = shellAutoDecision("zoo", PILLS, false);
		expect(d).toMatchObject({
			variant: "banner",
			mode: "unset",
			slug: "zoo",
			delay: 5,
			prefOn: false,
		});
	});

	test("%7C encoding decodes; segments parse", () => {
		const d = shellAutoDecision("zoo%7Cauto-on%7Cd3", PILLS, false);
		expect(d).toMatchObject({
			variant: "overlay",
			mode: "on",
			slug: "zoo",
			delay: 3,
			prefOn: true,
		});
	});

	test("dotted slugs survive (the pipe separator exists for them)", () => {
		const pills = [{ slug: "martinvr.eth", url: "https://x/", scheme: "", intent: "" }];
		const d = shellAutoDecision("martinvr.eth|auto-on", pills, false);
		expect(d?.slug).toBe("martinvr.eth");
	});

	test("garbage and kind segments are ignored on casts", () => {
		const d = shellAutoDecision("zoo|junk|p:firefly|auto-off", PILLS, false);
		expect(d).toMatchObject({ variant: "chip", mode: "off", slug: "zoo", prefOn: false });
	});

	test("out-of-range delay segments fall back to 5", () => {
		const d = shellAutoDecision("zoo|d9|d2", PILLS, false);
		expect(d?.delay).toBe(2); // the LAST valid segment wins, garbage skipped
	});

	test("empty slug ⇒ null", () => {
		expect(shellAutoDecision("|auto-on", PILLS, false)).toBeNull();
	});
});

describe("resolution over the offered pill set", () => {
	test("resolved unset: banner carries the pill's targets", () => {
		const d = shellAutoDecision("zoo", PILLS, false);
		expect(d).toMatchObject({
			url: "https://farcaster.xyz/zoo/0xabc",
			scheme: "farcaster://zoo/0xabc",
			intent: "intent://zoo/0xabc#Intent;scheme=farcaster;end",
		});
	});

	test("resolved off: chip, prefOn false", () => {
		expect(shellAutoDecision("firefly|auto-off", PILLS, false)).toMatchObject({
			variant: "chip",
			mode: "off",
			slug: "firefly",
			prefOn: false,
		});
	});

	test("resolved on: overlay", () => {
		expect(shellAutoDecision("firefly|auto-on", PILLS, false)).toMatchObject({
			variant: "overlay",
			mode: "on",
			slug: "firefly",
		});
	});
});

describe("noredirect downgrades to the chip", () => {
	test("auto-on + noredirect ⇒ chip, prefOn true", () => {
		expect(shellAutoDecision("zoo|auto-on", PILLS, true)).toMatchObject({
			variant: "chip",
			mode: "noredirect",
			prefOn: true,
		});
	});

	test("unset + noredirect ⇒ chip, prefOn false", () => {
		expect(shellAutoDecision("zoo", PILLS, true)).toMatchObject({
			variant: "chip",
			mode: "noredirect",
			prefOn: false,
		});
	});
});

describe("idle: armed but unoffered", () => {
	test("auto-on with an unoffered slug ⇒ idle (generic copy client-side)", () => {
		const d = shellAutoDecision("gone|auto-on", PILLS, false);
		expect(d).toMatchObject({ variant: "idle", mode: "on", slug: "gone", prefOn: true });
	});

	test("auto-off/unset with an unoffered slug ⇒ silence (null)", () => {
		expect(shellAutoDecision("gone|auto-off", PILLS, false)).toBeNull();
		expect(shellAutoDecision("gone", PILLS, false)).toBeNull();
	});

	test("idle + noredirect ⇒ silence (noredirect never explains)", () => {
		expect(shellAutoDecision("gone|auto-on", PILLS, true)).toBeNull();
	});

	test("delay 0 rides the idle decision (immediate redirect elsewhere)", () => {
		expect(shellAutoDecision("gone|auto-on|d0", PILLS, false)?.delay).toBe(0);
	});
});
