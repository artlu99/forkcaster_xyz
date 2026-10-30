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
		expect(shellAutoDecision(undefined, PILLS, false, "cast")).toBeNull();
		expect(shellAutoDecision("", PILLS, false, "cast")).toBeNull();
	});

	test("bare slug = unset arming, default delay 5", () => {
		const d = shellAutoDecision("zoo", PILLS, false, "cast");
		expect(d).toMatchObject({
			variant: "banner",
			mode: "unset",
			slug: "zoo",
			delay: 5,
			prefOn: false,
		});
	});

	test("%7C encoding decodes; segments parse", () => {
		const d = shellAutoDecision("zoo%7Cauto-on%7Cd3", PILLS, false, "cast");
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
		const d = shellAutoDecision("martinvr.eth|auto-on", pills, false, "cast");
		expect(d?.slug).toBe("martinvr.eth");
	});

	test("garbage and kind segments are ignored on casts", () => {
		const d = shellAutoDecision("zoo|junk|p:firefly|auto-off", PILLS, false, "cast");
		expect(d).toMatchObject({ variant: "chip", mode: "off", slug: "zoo", prefOn: false });
	});

	test("out-of-range delay segments fall back to 5", () => {
		const d = shellAutoDecision("zoo|d9|d2", PILLS, false, "cast");
		expect(d?.delay).toBe(2); // the LAST valid segment wins, garbage skipped
	});

	test("empty slug ⇒ null", () => {
		expect(shellAutoDecision("|auto-on", PILLS, false, "cast")).toBeNull();
	});
});

describe("resolution over the offered pill set", () => {
	test("resolved unset: banner carries the pill's targets", () => {
		const d = shellAutoDecision("zoo", PILLS, false, "cast");
		expect(d).toMatchObject({
			url: "https://farcaster.xyz/zoo/0xabc",
			scheme: "farcaster://zoo/0xabc",
			intent: "intent://zoo/0xabc#Intent;scheme=farcaster;end",
		});
	});

	test("resolved off: chip, prefOn false", () => {
		expect(shellAutoDecision("firefly|auto-off", PILLS, false, "cast")).toMatchObject({
			variant: "chip",
			mode: "off",
			slug: "firefly",
			prefOn: false,
		});
	});

	test("resolved on: overlay", () => {
		expect(shellAutoDecision("firefly|auto-on", PILLS, false, "cast")).toMatchObject({
			variant: "overlay",
			mode: "on",
			slug: "firefly",
		});
	});
});

describe("noredirect downgrades to the chip", () => {
	test("auto-on + noredirect ⇒ chip, prefOn true", () => {
		expect(shellAutoDecision("zoo|auto-on", PILLS, true, "cast")).toMatchObject({
			variant: "chip",
			mode: "noredirect",
			prefOn: true,
		});
	});

	test("unset + noredirect ⇒ chip, prefOn false", () => {
		expect(shellAutoDecision("zoo", PILLS, true, "cast")).toMatchObject({
			variant: "chip",
			mode: "noredirect",
			prefOn: false,
		});
	});
});

describe("idle: armed but unoffered", () => {
	test("auto-on with an unoffered slug ⇒ idle (generic copy client-side)", () => {
		const d = shellAutoDecision("gone|auto-on", PILLS, false, "cast");
		expect(d).toMatchObject({ variant: "idle", mode: "on", slug: "gone", prefOn: true });
	});

	test("auto-off/unset with an unoffered slug ⇒ silence (null)", () => {
		expect(shellAutoDecision("gone|auto-off", PILLS, false, "cast")).toBeNull();
		expect(shellAutoDecision("gone", PILLS, false, "cast")).toBeNull();
	});

	test("idle + noredirect ⇒ silence (noredirect never explains)", () => {
		expect(shellAutoDecision("gone|auto-on", PILLS, true, "cast")).toBeNull();
	});

	test("delay 0 rides the idle decision (immediate redirect elsewhere)", () => {
		expect(shellAutoDecision("gone|auto-on|d0", PILLS, false, "cast")?.delay).toBe(0);
	});
});

describe("kind-aware resolution (profiles: p: segment, then the head)", () => {
	const PROFILE_OFFERED: ShellPill[] = [
		{ slug: "farcaster", url: "https://farcaster.xyz/decent-artlu", scheme: "", intent: "" },
		{ slug: "quilcast", url: "https://quilcast.com/u/decent-artlu", scheme: "", intent: "" },
	];

	test("p: segment resolves the profile kind, outranking the head", () => {
		expect(
			shellAutoDecision("farcaster|p:quilcast|auto-on", PROFILE_OFFERED, false, "profile"),
		).toMatchObject({
			variant: "overlay",
			mode: "on",
			slug: "quilcast",
			url: "https://quilcast.com/u/decent-artlu",
			prefOn: true,
		});
	});

	test("no p: segment inherits the head slug (flat, never another kind's choice)", () => {
		expect(
			shellAutoDecision("farcaster|auto-on", PROFILE_OFFERED, false, "profile"),
		).toMatchObject({ variant: "overlay", mode: "on", slug: "farcaster" });
		// The f: segment belongs to feeds — never the profile's choice.
		const f = shellAutoDecision("linkcast|f:quilcast|auto-on", PROFILE_OFFERED, false, "profile");
		expect(f?.slug).toBe("linkcast");
	});

	test("an incapable candidate (head, no p:) ⇒ idle in the arming state", () => {
		expect(
			shellAutoDecision("linkcast|auto-on", PROFILE_OFFERED, false, "profile"),
		).toMatchObject({ variant: "idle", mode: "on", slug: "linkcast", prefOn: true });
	});

	test("incapable + off/noredirect ⇒ silence", () => {
		expect(shellAutoDecision("linkcast|auto-off", PROFILE_OFFERED, false, "profile")).toBeNull();
		expect(shellAutoDecision("linkcast|auto-on", PROFILE_OFFERED, true, "profile")).toBeNull();
	});
});
