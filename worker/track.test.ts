/**
 * Track event validation (POST /t): the allow-list drops everything that
 * is not exactly a known client × known kind × known flag shape, and the
 * AE row mapping puts slug in the index and the declared negative list in
 * blobs. The kill switch is honored here: eol/suspended ids are dropped.
 */
import { describe, expect, test } from "bun:test";

import {
	parseTrackEvent,
	trackBlobs,
	MAX_BODY_BYTES,
} from "./track.ts";

const VALID = JSON.stringify({
	c: "firefly",
	k: "pill",
	t: "native",
	d: "coarse",
	f: "switch",
});

describe("parseTrackEvent", () => {
	test("accepts a fully-specified pill event", () => {
		expect(parseTrackEvent(VALID)).toEqual({
			slug: "firefly",
			kind: "pill",
			transport: "native",
			device: "coarse",
			first: "switch",
		});
	});

	test("defaults: transport=web, device and first flags optional", () => {
		expect(parseTrackEvent(JSON.stringify({ c: "quorum", k: "auto" }))).toEqual({
			slug: "quorum",
			kind: "auto",
			transport: "web",
			device: "",
			first: "",
		});
		expect(
			parseTrackEvent(JSON.stringify({ c: "neynar", k: "go-now", d: "fine" })),
		).toEqual({
			slug: "neynar",
			kind: "go-now",
			transport: "web",
			device: "fine",
			first: "",
		});
	});

	test("the first-flag is ignored on auto/go-now events", () => {
		const parsed = parseTrackEvent(
			JSON.stringify({ c: "firefly", k: "auto", f: "first" }),
		);
		expect(parsed?.first).toBe("");
	});

	test("unknown slugs are dropped — registry whitelist", () => {
		expect(parseTrackEvent(JSON.stringify({ c: "nope", k: "pill" }))).toBeNull();
		expect(parseTrackEvent(JSON.stringify({ c: "", k: "pill" }))).toBeNull();
		expect(parseTrackEvent(JSON.stringify({ k: "pill" }))).toBeNull();
	});

	test("unknown kinds/transports/devices/flags are dropped or normalized", () => {
		expect(parseTrackEvent(JSON.stringify({ c: "firefly", k: "hover" }))).toBeNull();
		expect(parseTrackEvent(JSON.stringify({ c: "firefly", k: 7 }))).toBeNull();
		// Unknown enum-ish values fall back to defaults rather than pass through.
		expect(parseTrackEvent(JSON.stringify({ c: "firefly", k: "pill", t: "teleport" }))?.transport).toBe("web");
		expect(parseTrackEvent(JSON.stringify({ c: "firefly", k: "pill", d: "gpu" }))?.device).toBe("");
		expect(parseTrackEvent(JSON.stringify({ c: "firefly", k: "pill", f: "always" }))?.first).toBe("");
	});

	test("non-JSON, non-object, and oversize bodies are dropped", () => {
		expect(parseTrackEvent("not json")).toBeNull();
		expect(parseTrackEvent("[1,2,3]")).toBeNull();
		expect(parseTrackEvent("42")).toBeNull();
		expect(parseTrackEvent("null")).toBeNull();
		expect(parseTrackEvent("x".repeat(MAX_BODY_BYTES + 1))).toBeNull();
		// At the cap, a valid object (padded with tolerated whitespace) parses.
		const atCap = JSON.stringify({ c: "firefly", k: "pill" }).padEnd(
			MAX_BODY_BYTES,
			" ",
		);
		expect(atCap.length).toBe(MAX_BODY_BYTES);
		expect(parseTrackEvent(atCap)?.slug).toBe("firefly");
	});
});

describe("trackBlobs (the declared negative list, in blob form)", () => {
	test("index is the slug; blobs are kind:transport, device, first flag, host", () => {
		const event = parseTrackEvent(VALID);
		expect(event).not.toBeNull();
		expect(trackBlobs(event as NonNullable<typeof event>, "forkcaster.xyz")).toEqual([
			"pill:native",
			"coarse",
			"switch",
			"forkcaster.xyz",
		]);
	});

	test("absent device/first flags become the '-' sentinel, never empty blobs", () => {
		const event = parseTrackEvent(JSON.stringify({ c: "quorum", k: "auto" }));
		expect(event).not.toBeNull();
		expect(trackBlobs(event as NonNullable<typeof event>, "warpcats.com")).toEqual([
			"auto:web",
			"-",
			"-",
			"warpcats.com",
		]);
	});
});
