/**
 * The ?embeds=quotes heal fragment races the fleet: with SHIM_POTATO_BASE
 * set, BOTH the cast resolution (/wc) and the quote hydration (/h) go to
 * var members only — zero cloud fetches (a heal that depended on one host
 * would rebuild the SPOF the fleet removed). Without the var the route is
 * the legacy cloud pass-through (covered by cast-route.test.ts); here the
 * var is explicit and cloud must never be contacted — the fetch mock
 * THROWS on unexpected URLs, so any cloud fetch fails the test loudly.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));
mock.module("react", () => require("preact/compat"));
mock.module("react-dom", () => require("preact/compat"));
mock.module("react/jsx-runtime", () => require("preact/jsx-runtime"));
mock.module("react/jsx-dev-runtime", () => require("preact/jsx-runtime"));

const { renderQuotesFragment } = await import("./cast-page.tsx");

const originalFetch = globalThis.fetch;
let calls: string[] = [];

/** Fetch routed by exact URL; unexpected URLs throw (the loud assertion). */
function shimMock(routes: Record<string, unknown>): void {
	calls = [];
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		calls.push(url);
		const route = routes[url];
		if (route === undefined) throw new Error(`Unexpected fetch in test: ${url}`);
		if (route instanceof Error) throw route;
		return Response.json(route);
	}) as typeof fetch;
}

const A = "https://a.test";
const B = "https://b.test";
const HASH = "0x7fea908d7e9bc0804288771b02d693128f4d3b7f";
const QUOTED_HASH = "0x3b71f5d4b7c38e16ec473b791a0463a8874e5926";
const USERNAME = "mvr";

const QUOTED = {
	fid: 366713,
	hash: QUOTED_HASH,
	text: "Hey are neynar scores being updated or are they obsolete?",
	timestamp: 1793000000,
	embeds: [],
	user: {
		fid: 366713,
		username: "nikolaii.eth",
		fname: "nikolaiii",
		displayName: "nikolaii.eth",
		pfpUrl: "https://img.test/p.png",
	},
};
const QUOTER = {
	fid: 230238,
	hash: HASH,
	text: "No actual @neynar score changes recorded yet",
	timestamp: 1793685920,
	embeds: [{ castId: { fid: 366713, hash: QUOTED_HASH } }],
	user: { fid: 230238, username: "mvr", fname: "mvr" },
};

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("renderQuotesFragment — fleet-raced heal", () => {
	test("resolves + hydrates through var members only; cloud never fetched", async () => {
		shimMock({
			[`${A}/wc/${USERNAME}/${HASH}`]: { success: true, cast: QUOTER },
			[`${B}/wc/${USERNAME}/${HASH}`]: { success: true, cast: QUOTER },
			[`${A}/h/${QUOTED_HASH}`]: { success: true, cast: QUOTED },
			[`${B}/h/${QUOTED_HASH}`]: { success: true, cast: QUOTED },
		});
		const r = await renderQuotesFragment(USERNAME, HASH, `${A},${B}`);
		expect(r.status).toBe(200);
		expect(r.html).toContain("quote-embeds");
		// The card renders the author from castData (username handle — the
		// toCastData identity-law question is a separate, pre-existing gap
		// shared by every embed card; the fname preference is NOT applied
		// here, see primaryHandle above which the renderEmbedCard username
		// param carries but the bundle's author block does not).
		expect(r.html).toContain("@nikolaii.eth");
		// Every shim fetch went to the fleet — zero cloud (the mock would
		// have thrown on shim.artlu.xyz URLs already).
		for (const url of calls) {
			expect(url.startsWith(A) || url.startsWith(B)).toBe(true);
		}
		expect(calls.some((u) => u.includes("/wc/"))).toBe(true);
		expect(calls.some((u) => u.includes("/h/"))).toBe(true);
	});

	test("consensus miss (every leg consulted-and-missed) is a 404", async () => {
		const miss = { success: false };
		shimMock({
			[`${A}/wc/${USERNAME}/${HASH}`]: miss,
			[`${B}/wc/${USERNAME}/${HASH}`]: miss,
		});
		const r = await renderQuotesFragment(USERNAME, HASH, `${A},${B}`);
		expect(r.status).toBe(404);
		expect(r.html).toBe("");
		// A landed miss waits for the pending leg — both members vote.
		expect(calls.filter((u) => u.includes("/wc/")).length).toBe(2);
	});

	test("fleet error surfaces as 503, not a silent empty 200", async () => {
		shimMock({
			[`${A}/wc/${USERNAME}/${HASH}`]: new Error("boom"),
			[`${B}/wc/${USERNAME}/${HASH}`]: new Error("boom"),
		});
		const r = await renderQuotesFragment(USERNAME, HASH, `${A},${B}`);
		expect(r.status).toBe(503);
		expect(r.html).toBe("");
	});
});
