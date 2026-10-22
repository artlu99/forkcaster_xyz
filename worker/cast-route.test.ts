/**
 * Cast route integration tests.
 *
 * worker/index.ts contract:
 *   export const app = new Hono();
 *   export default { fetch: app.fetch };
 *
 * Tests call `app.request(...)`. Cloudflare uses the default export.
 * Shim (shim.artlu.xyz) is the sole data source; globalThis.fetch is mocked
 * and routed by exact URL — unexpected URLs throw, exercising fallbacks.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));
// CJS deps (linkify-react) call require("react"); sync preact/compat works.
mock.module("react", () => require("preact/compat"));
mock.module("react-dom", () => require("preact/compat"));
mock.module("react/jsx-runtime", () => require("preact/jsx-runtime"));
mock.module("react/jsx-dev-runtime", () => require("preact/jsx-runtime"));

const { app } = await import("./index.ts");

const CAST_TEXT = "omg so relevant!";
const SHORT_HASH = "0x895ecc74";
const FULL_HASH = "0x895ecc7415208bfb6105a8cb675f391f19cb9e2c";

// Shape as returned by shim.artlu.xyz /wc/{username}/{shortHash}:
// Snapchain message data — unix-SECOND timestamp, raw {url}/{castId} embeds.
const SHIM_CAST = {
	fid: 10215,
	hash: FULL_HASH,
	text: CAST_TEXT,
	embeds: [
		{
			url: "https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/0eeef320/original",
		},
	],
	timestamp: 1_792_425_174,
	user: {
		fid: 10215,
		username: "zoo",
		displayName: "zoo",
		pfpUrl:
			"https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/ab8e1aa9/original",
		bio: "primus amanuensis @qbase",
	},
};

const originalFetch = globalThis.fetch;

// decent-artlu's cast: same data, but fid 3319217 has NOT signed, and its
// URL embed has no unfurl mock — hostname fallback must still render.
// The hash matches its route: the race's central validation rejects any
// found cast that doesn't resolve the requested hash.
const ARTLU_HASH = "0xbb54368fa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
const ARTLU_CAST = {
	...SHIM_CAST,
	fid: 3319217,
	hash: ARTLU_HASH,
	embeds: [{ url: "https://example.com/article" }],
};
// fid with no /signed mock: its signed-check fetch throws (fail-open path).
// Its quote embed has no /h mock either: hydration fails, quote is dropped.
const UNKNOWN_SIGNED_CAST = {
	...SHIM_CAST,
	fid: 7777777,
	hash: "0x11111111deadbeefdeadbeefdeadbeefdeadbeef",
	embeds: [{ castId: { fid: 3854, hash: "0x11111111deadbeef" } }],
};
// The cast quoted by /zoo/0x79794547 (hydration via /h/{fullHash}).
const QUOTED_CAST = {
	fid: 3854,
	hash: "0xa7c5f47033da848d6d16dac11c61838634a50c23",
	text: "the original quoted take",
	timestamp: 1_700_000_000,
	user: {
		fid: 3854,
		username: "quoteduser",
		displayName: "Quoted User",
		pfpUrl: "https://img.example.test/q.png",
	},
};
// Regression: the real /zoo/0x79794547 cast — a quote embed + a URL embed.
// The bundle reads quote.author.pfp.url unguarded; quotes are dropped and
// URL embeds render as link cards.
const QUOTE_URL_CAST = {
	...SHIM_CAST,
	hash: "0x797945472e1ed7dfe53da94c03ad972ef7fc5fd4",
	embeds: [
		{
			castId: { fid: 3854, hash: "0xa7c5f47033da848d6d16dac11c61838634a50c23" },
		},
		{
			url: "https://newrepublic.com/article/180487/balaji-srinivasan-network-state-plutocrat",
		},
	],
};

beforeEach(() => {
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === `https://shim.artlu.xyz/wc/zoo/${SHORT_HASH}`) {
			return Response.json({ success: true, cast: SHIM_CAST });
		}
		if (url === "https://shim.artlu.xyz/wc/zoo/0x11111111") {
			return Response.json({ success: true, cast: UNKNOWN_SIGNED_CAST });
		}
		if (url === "https://shim.artlu.xyz/wc/zoo/0x79794547") {
			return Response.json({ success: true, cast: QUOTE_URL_CAST });
		}
		if (
			url ===
			"https://shim.artlu.xyz/h/0xa7c5f47033da848d6d16dac11c61838634a50c23"
		) {
			return Response.json({ success: true, cast: QUOTED_CAST });
		}
		if (
			url ===
			`https://unfurl.artlu.workers.dev/?u=${encodeURIComponent("https://newrepublic.com/article/180487/balaji-srinivasan-network-state-plutocrat")}`
		) {
			return Response.json({
				ogTitle: "Balaji and the Network State",
				ogDescription: "A test description",
				ogImage: [{ url: "https://img.example.test/cover.jpg" }],
			});
		}
		if (url === "https://shim.artlu.xyz/signed/10215") {
			return Response.json({ success: true, signed: true });
		}
		if (url === "https://shim.artlu.xyz/wc/decent-artlu/0xbb54368f") {
			return Response.json({ success: true, cast: ARTLU_CAST });
		}
		if (url === "https://shim.artlu.xyz/signed/3319217") {
			return Response.json({ success: true, signed: false });
		}
		if (url === "https://shim.artlu.xyz/wc/zoo/0xdeadbeef") {
			return Response.json({ success: false, error: "cast not found" });
		}
		if (url === "https://shim.artlu.xyz/wc/zoo/0x00000000") {
			throw new Error("shim unavailable");
		}
		throw new Error(`Unexpected fetch in test: ${url}`);
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("GET /api/ returns Cloudflare JSON", async () => {
	const res = await app.request("/api/");
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({ name: "Cloudflare" });
});

test("GET /:username/:hash SSR-renders the cast card from Shim data", async () => {
	const res = await app.request(`/zoo/${SHORT_HASH}`);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type") ?? "").toContain("text/html");

	const body = await res.text();
	expect(body).toContain(CAST_TEXT);
	expect(body).toContain(`https://farcaster.xyz/zoo/${SHORT_HASH}`);
	// The Firefly link uses the full hash Shim resolved.
	expect(body).toContain(`https://firefly.social/post/farcaster/${FULL_HASH}`);
	// OG/Twitter meta for unfurlers (Telegram, Discord, iMessage).
	expect(body).toContain('<meta property="og:title" content="zoo (@zoo)" />');
	expect(body).toContain(
		`<meta property="og:image" content="https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/0eeef320/original" />`,
	);
	expect(body).toContain('name="twitter:card" content="summary_large_image"');
	// Engagement counters would be hardcoded zeros (Shim has no counts):
	// the SSR output ships an empty stats slot + inline script, which fills
	// the row client-side from farcaster.tv. Nothing rendered in <main>.
	const card = body.slice(body.indexOf("<main>"), body.indexOf("</main>"));
	expect(card).not.toContain("farcaster-embed-stats-link");
	expect(card).not.toContain("<ul>");
	expect(body).toContain("farcaster-embed-farcaster-link");
	expect(body).toContain('data-username="zoo"');
	expect(body).toContain(`data-hash="${SHORT_HASH}"`);
	expect(body).toContain("https://farcaster.tv/");

	const fetchMock = globalThis.fetch as ReturnType<typeof mock>;
	expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
		`https://shim.artlu.xyz/wc/zoo/${SHORT_HASH}`,
	);
});

test("GET /:username/:hash hides the farcaster link when the author has not signed", async () => {
	const res = await app.request("/decent-artlu/0xbb54368f");
	expect(res.status).toBe(200);

	const body = await res.text();
	// The embed still renders for unsigned authors...
	expect(body).toContain(CAST_TEXT);
	expect(body).toContain(`https://firefly.social/post/farcaster/${ARTLU_HASH}`);
	// URL embed unfurl failed (no mock) — hostname fallback still renders.
	expect(body).toContain("example.com");
	// ...but the registry's requiresSigned clients (farcaster) are suppressed.
	expect(body).not.toContain('data-client="farcaster"');
	expect(body).not.toContain("https://farcaster.xyz/decent-artlu/0xbb54368f");
	// With farcaster gone, no rendered client has a native scheme — the
	// mobile deeplink script doesn't ship on this page at all.
	expect(body).not.toContain("data-scheme");
	expect(body).not.toContain("pointer: coarse");
	expect(body).toContain("social smart contract");
});

test("GET /:username/:hash fails open when the signed-check is unavailable", async () => {
	const res = await app.request("/zoo/0x11111111");
	expect(res.status).toBe(200);

	const body = await res.text();
	expect(body).toContain('data-client="farcaster"');
	expect(body).toContain("https://farcaster.xyz/zoo/0x11111111");
	expect(body).not.toContain("social smart contract");
});

test("GET /:username/:hash renders quote+url embed casts without crashing", async () => {
	const res = await app.request("/zoo/0x79794547");
	expect(res.status).toBe(200);

	const body = await res.text();
	expect(body).not.toContain("temporarily unavailable");
	expect(body).toContain("newrepublic.com");
	// URL embed enriched via unfurl.
	expect(body).toContain("Balaji and the Network State");
	expect(body).toContain("A test description");
	// Quote embed hydrated via Shim /h.
	expect(body).toContain("the original quoted take");
	expect(body).toContain("Quoted User");
	expect(body).toContain("https://farcaster.xyz/zoo/0x79794547");
});

test("GET /:username/:hash footer shows the GitHub mark and MIT license", async () => {
	const res = await app.request(`/zoo/${SHORT_HASH}`);
	expect(res.status).toBe(200);

	const body = await res.text();
	const footer = body.slice(body.indexOf('<footer class="site-footer">'));
	// Footer marks come from simple-icons (no hand-inlined SVG), each
	// aria-hidden with the brand <title> stripped so the link name is the label.
	expect(footer).toContain("<svg");
	expect(footer).toContain("MIT");
	expect(footer).not.toContain(">source<");
	expect(footer).toContain("tab=contributing-ov-file");
	expect(footer).toContain("Contributing");
	expect(footer).toContain('href="/transparency"');
	expect(footer).toContain("Transparency");
	expect(footer.match(/aria-hidden="true"/g)?.length).toBe(3);
	expect(footer).not.toContain("<title>");
});

test("GET /:username/:hash returns 404 when Shim reports no such cast", async () => {
	const res = await app.request("/zoo/0xdeadbeef");
	expect(res.status).toBe(404);

	const body = await res.text();
	expect(body).toContain("not found");
	expect(body).not.toContain(CAST_TEXT);
});

test("GET /:username/:hash falls back to a link-only page when Shim is unreachable", async () => {
	const res = await app.request("/zoo/0x00000000");
	expect(res.status).toBe(200);

	const body = await res.text();
	expect(body).toContain("https://farcaster.xyz/zoo/0x00000000");
	expect(body).not.toContain(CAST_TEXT);
});

// --- Client registry (action row, last-used cookie, logos) ------------------
//
// The action row is rendered from worker/clients.ts: one pill per
// registry client with its own logo, the pill matching the fc_client
// cookie carrying a "last used" badge. Unknown cookie ids render
// nothing (registry whitelist).

test("GET /:username/:hash renders the registry-driven client action row", async () => {
	const res = await app.request(`/zoo/${SHORT_HASH}`);
	expect(res.status).toBe(200);

	const body = await res.text();
	// One pill per registry client, each with its own logo mark.
	expect(body).toContain('data-client="farcaster"');
	expect(body).toContain('data-client="firefly"');
	expect(body).toContain('data-client="neynar"');
	expect(body).toContain('data-client="quilcast"');
	expect(body).toContain("/logos/farcaster.svg");
	expect(body).toContain("/logos/firefly.png");
	expect(body).toContain("/logos/neynar.png");
	expect(body).toContain("/logos/quilcast.svg");
	// Per-cast templates interpolate.
	expect(body).toContain(`href="https://farcaster.xyz/zoo/${SHORT_HASH}"`);
	expect(body).toContain(
		`href="https://firefly.social/post/farcaster/${FULL_HASH}"`,
	);
	// Format verified against fc-clients-cast-action: full-hash based.
	expect(body).toContain(`href="https://explorer.neynar.com/${FULL_HASH}"`);
	// Format verified against backmeupplz/quilcast: /c/ requires 40 hex
	// (optional 0x) — the full hash.
	expect(body).toContain(`href="https://quilcast.com/c/${FULL_HASH}"`);
	// Farcaster ships the only native scheme — verified against the
	// open-source app (farcasterxyz/client): scheme paths mirror the web
	// path, /{username}/{fullHash}. Web href stays canonical; scheme +
	// intent ride as data attributes.
	expect(body).toContain(
		'data-scheme="farcaster://zoo/0x895ecc7415208bfb6105a8cb675f391f19cb9e2c"',
	);
	expect(body).toContain('data-intent="intent://zoo/0x895ecc74');
	expect(body).toContain("package=com.farcaster.mobile");
	expect(body).toContain("S.browser_fallback_url=");
	expect(body).toContain("pointer: coarse");
	// The click-to-remember script ships on the page; no cookie, no badge.
	expect(body).toContain("fc_client=");
	expect(body).not.toContain('class="pill-badge"');
});

test("GET /:username/:hash badges the cookie's last-used client", async () => {
	const res = await app.request(`/zoo/${SHORT_HASH}`, {
		headers: { Cookie: "fc_client=firefly" },
	});
	expect(res.status).toBe(200);

	const body = await res.text();
	// Exactly one badged pill, and it is firefly's.
	expect((body.match(/class="pill-badge"/g) ?? []).length).toBe(1);
	const start = body.indexOf('data-client="firefly"');
	const pill = body.slice(start, body.indexOf("</a>", start));
	expect(pill).toContain('class="pill-badge"');
	expect(pill).toContain("last used");
});

test("unknown fc_client cookie values render no badge", async () => {
	const res = await app.request(`/zoo/${SHORT_HASH}`, {
		headers: { Cookie: "fc_client=not-a-client" },
	});
	expect(res.status).toBe(200);

	const body = await res.text();
	// The registry whitelist ignores unknown ids — no badge, no injection.
	expect(body).not.toContain('class="pill-badge"');
	expect(body).toContain('data-client="farcaster"');
});

test("the badge follows suppression: no badge for a hidden client", async () => {
	// decent-artlu hasn't signed: farcaster is suppressed, so a last-used
	// cookie naming farcaster badges nothing. Firefly still renders.
	const res = await app.request("/decent-artlu/0xbb54368f", {
		headers: { Cookie: "fc_client=farcaster" },
	});
	expect(res.status).toBe(200);

	const body = await res.text();
	expect(body).not.toContain('data-client="farcaster"');
	expect(body).not.toContain('class="pill-badge"');
	expect(body).toContain('data-client="firefly"');
});

// --- Agent JSON variant (?format=json) --------------------------------------
//
// ?format=json (and Accept: application/json) serves machine-readable cast
// data for AI agents. Unlike HTML, JSON uses STRICT statuses: 404 when Shim
// has no such cast, 503 + Retry-After when Shim is unreachable. Availability-gated
// fields (note/links/quotes/...) appear ONLY when their data exists.

test("GET /:username/:hash?format=json returns the agent JSON variant", async () => {
	const res = await app.request(`/zoo/${SHORT_HASH}?format=json`);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type") ?? "").toContain("application/json");

	const body = await res.json();
	expect(body.author).toEqual({
		username: "zoo",
		displayName: "zoo",
		fid: 10215,
	});
	expect(body.text).toBe(CAST_TEXT);
	// Shim timestamps are unix SECONDS.
	expect(body.timestamp).toBe(new Date(1_792_425_174 * 1000).toISOString());
	expect(body.images).toEqual([
		"https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/0eeef320/original",
	]);
	expect(body.farcaster).toBe(`https://farcaster.xyz/zoo/${SHORT_HASH}`);
	// The Firefly link uses the full hash Shim resolved.
	expect(body.firefly).toBe(
		`https://firefly.social/post/farcaster/${FULL_HASH}`,
	);
	// signed:true + no URL/quote embeds: gated fields stay absent.
	expect("note" in body).toBe(false);
	expect("links" in body).toBe(false);
	expect("quotes" in body).toBe(false);
});

test("GET ?format=json emits unfurl titles and hydrated quote pointers", async () => {
	const res = await app.request("/zoo/0x79794547?format=json");
	expect(res.status).toBe(200);

	const body = await res.json();
	// URL embed enriched via unfurl: title present.
	expect(body.links).toEqual([
		{
			url: "https://newrepublic.com/article/180487/balaji-srinivasan-network-state-plutocrat",
			title: "Balaji and the Network State",
		},
	]);
	// Hydrated quote → a forkcaster pointer: request origin + the quoted
	// cast's username + its FULL hash. Quotes are never dropped.
	expect(body.quotes).toEqual([
		"http://localhost/quoteduser/0xa7c5f47033da848d6d16dac11c61838634a50c23",
	]);
	// fid 10215 signed:true — no note.
	expect("note" in body).toBe(false);
});

test("GET ?format=json notes unsigned authors and degrades unfurl to bare URLs", async () => {
	const res = await app.request("/decent-artlu/0xbb54368f?format=json");
	expect(res.status).toBe(200);

	const body = await res.json();
	// signed:false — the JSON carries a note (exact copy is an
	// implementation detail; only its presence is contractual).
	expect(typeof body.note).toBe("string");
	// No unfurl mock for example.com: bare URL, no title.
	expect(body.links).toEqual([{ url: "https://example.com/article" }]);
});

test("GET ?format=json fails open on the signed check and points unhydrated quotes at Firefly", async () => {
	const res = await app.request("/zoo/0x11111111?format=json");
	expect(res.status).toBe(200);

	const body = await res.json();
	// No /signed mock for fid 7777777: the check throws — fail open means
	// NO note, same as the HTML path.
	expect("note" in body).toBe(false);
	// No /h mock for the quoted cast: hydration fails, but the quote
	// survives as a Firefly pointer built from the embed's castId hash.
	expect(body.quotes).toEqual([
		"https://firefly.social/post/farcaster/0x11111111deadbeef",
	]);
});

test("GET ?format=json returns 404 with a JSON error when the cast is missing", async () => {
	const res = await app.request("/zoo/0xdeadbeef?format=json");
	expect(res.status).toBe(404);
	expect(res.headers.get("content-type") ?? "").toContain("application/json");
	expect(await res.json()).toEqual({ error: "cast not found" });
});

test("GET ?format=json returns 503 + Retry-After when Shim is unreachable", async () => {
	const res = await app.request("/zoo/0x00000000?format=json");
	expect(res.status).toBe(503);
	expect(res.headers.get("retry-after")).toBe("60");
	expect(await res.json()).toEqual({
		error: "cast data temporarily unavailable",
	});
});

test("Accept: application/json negotiates the JSON variant; */* and text/html stay HTML", async () => {
	const jsonRes = await app.request(`/zoo/${SHORT_HASH}`, {
		headers: { Accept: "application/json" },
	});
	expect(jsonRes.headers.get("content-type") ?? "").toContain(
		"application/json",
	);

	// Browsers and curl send */*: that must stay HTML — only the strict
	// application/json Accept negotiates JSON.
	const anyRes = await app.request(`/zoo/${SHORT_HASH}`, {
		headers: { Accept: "*/*" },
	});
	expect(anyRes.headers.get("content-type") ?? "").toContain("text/html");

	const htmlRes = await app.request(`/zoo/${SHORT_HASH}`, {
		headers: { Accept: "text/html" },
	});
	expect(htmlRes.headers.get("content-type") ?? "").toContain("text/html");
});

test("HTML pages advertise the JSON variant", async () => {
	const res = await app.request(`/zoo/${SHORT_HASH}`);
	expect(res.status).toBe(200);

	const body = await res.text();
	expect(body).toContain(
		'<link rel="alternate" type="application/json" href="?format=json" />',
	);
});

// A partial (quote-blind) win: no shim mock for this URL — shim errors,
// farcaster.tv resolves the cast, and the page ships with the quote
// fill-in script instead of quote cards.
const FCTV_ONLY_HASH = "0xbeefdead";
const FCTV_ONLY_FULL = "0xbeefdead0123456789abcdef0123456789abcdef";
const FCTV_ONLY_CAST = {
	result: {
		casts: [
			{
				hash: FCTV_ONLY_FULL,
				text: "rendered from farcaster.tv",
				timestamp: 1_792_425_174_000,
				author: {
					fid: 10215,
					username: "zoo",
					displayName: "zoo",
					pfp: { url: "https://img.test/fctv.png" },
				},
				embeds: { images: [], urls: [] },
			},
		],
	},
};

test("a quote-blind win ships the fill-in script and no quote cards", async () => {
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === `https://farcaster.tv/zoo/${FCTV_ONLY_HASH}`) {
			return Response.json(FCTV_ONLY_CAST);
		}
		throw new Error(`Unexpected fetch in test: ${url}`);
	}) as typeof fetch;
	const res = await app.request(`/zoo/${FCTV_ONLY_HASH}`);
	expect(res.status).toBe(200);

	const body = await res.text();
	// The cast renders from the partial source...
	expect(body).toContain("rendered from farcaster.tv");
	// ...with the quote fill-in script pointing at the fragment endpoint,
	expect(body).toContain('?embeds=quotes"');
	// but no server-rendered quote cards on this page.
	expect(body).not.toContain("quote-embeds");
});

test("GET ?embeds=quotes serves the shim-resolved quote-card fragment", async () => {
	const res = await app.request("/zoo/0x79794547?embeds=quotes");
	expect(res.status).toBe(200);
	expect(res.headers.get("cache-control")).toBe("no-store");

	const body = await res.text();
	expect(body).toContain("quote-embeds");
	// Quote hydrated through Shim /h.
	expect(body).toContain("the original quoted take");
});

test("GET ?embeds=quotes is a silent 404 for missing casts", async () => {
	const res = await app.request("/zoo/0xdeadbeef?embeds=quotes");
	expect(res.status).toBe(404);
});

test("GET /transparency serves terse facts; JSON twin; casts for username 'transparency' unaffected", async () => {
	const res = await app.request("/transparency");
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type") ?? "").toContain("text/html");
	const body = await res.text();
	expect(body).toContain("forkcaster — transparency");
	expect(body).toContain("first validated answer wins");
	expect(body).toContain("No cast IDs");
	expect(body).toContain("shim.artlu.xyz"); // provider roster table
	expect(body).toContain('href="/transparency"'); // footer link present

	const jsonRes = await app.request("/transparency?format=json");
	expect(jsonRes.status).toBe(200);
	expect(jsonRes.headers.get("content-type") ?? "").toContain(
		"application/json",
	);
	const json = await jsonRes.json();
	expect(json.data.providers).toHaveLength(4);
	expect(json.racingStats.status).toBe("coming-soon");
	expect(json.tracking.counters).toContain("No cast IDs");

	// A Farcaster user literally named "transparency": two-segment cast
	// URLs must still hit the cast handler (shim miss → 404, not the
	// transparency page).
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === "https://shim.artlu.xyz/wc/transparency/0xdeadbeef") {
			return Response.json({ success: false });
		}
		throw new Error(`Unexpected fetch in test: ${url}`);
	}) as typeof fetch;
	const castRes = await app.request("/transparency/0xdeadbeef");
	expect(castRes.status).toBe(404);
	expect(await castRes.text()).toContain("not found");
});

test("auto-open unset: countdown banner; ON: single-Pause arming; OFF: chip", async () => {
	// unset (bare slug): countdown status link + Pause — ONE choice in the
	// moment; settings appear only in the calm paused view.
	const unset = await app.request(`/zoo/${SHORT_HASH}`, {
		headers: { cookie: "fc_client=firefly" },
	});
	expect(unset.status).toBe(200);
	const unsetBody = await unset.text();
	expect(unsetBody).toContain('data-auto="unset"');
	expect(unsetBody).toContain('in <span class="auto-secs">5</span>s');
	expect(unsetBody).toContain('data-auto-action="pause"');
	// Exactly one "Auto-open:" occurrence — the script's chip builder — so
	// the arming view itself carries no settings chrome.
	expect((unsetBody.match(/Auto-open:/g) || []).length).toBe(1);
	expect(unsetBody).not.toContain('data-auto="on"');

	// ON: large arming overlay + redirect to the last-used client; the
	// single control is Pause (settings appear after pause).
	const on = await app.request(`/zoo/${SHORT_HASH}`, {
		headers: { cookie: "fc_client=firefly|auto-on" },
	});
	expect(on.status).toBe(200);
	const onBody = await on.text();
	expect(onBody).toContain('data-auto="on"');
	// The arming overlay carries ONE control (Pause) — no settings chrome.
	const overlayStart = onBody.indexOf('<div class="auto-overlay"');
	const overlayEnd = onBody.indexOf("</div>", overlayStart);
	const overlay = onBody.slice(overlayStart, overlayEnd);
	expect(overlay).toContain('data-auto-action="pause"');
	expect(overlay).not.toContain("Turn off auto-open");
	expect(overlay).toContain(
		'data-auto-url="https://firefly.social/post/farcaster/0x895ecc7415208bfb6105a8cb675f391f19cb9e2c"',
	);

	// OFF: status + two-way toggle chip inside the persistent container.
	const off = await app.request(`/zoo/${SHORT_HASH}`, {
		headers: { cookie: "fc_client=firefly|auto-off" },
	});
	expect(off.status).toBe(200);
	const offBody = await off.text();
	expect(offBody).toContain('data-auto="off"');
	expect(offBody).toContain('aria-pressed="false"');
	expect(offBody).toContain("Auto-open: Off");
	// No arming overlay / redirect in the OFF state (script text may mention
	// the labels; the markup must not).
	expect(offBody).not.toContain('data-auto="on"');
	expect(offBody).not.toContain('class="auto-overlay"');
});

test("no cookie: no auto-open markup at all (bots and first-timers)", async () => {
	const res = await app.request(`/zoo/${SHORT_HASH}`);
	expect(res.status).toBe(200);
	const body = await res.text();
	expect(body).not.toContain("data-auto");
	expect(body).not.toContain("Auto-open:");
});

test("signed suppression gates auto-open: suppressed client never redirects", async () => {
	// decent-artlu is unsigned; farcaster requires signing → the ON cookie
	// targeting farcaster must not arm any redirect.
	const res = await app.request("/decent-artlu/0xbb54368f", {
		headers: { cookie: "fc_client=farcaster|auto-on" },
	});
	expect(res.status).toBe(200);
	const body = await res.text();
	expect(body).not.toContain('data-auto="on"');
	expect(body).not.toContain("Turn off auto-open");
});

test("?noredirect=1 suppresses the redirect and shows the status chip", async () => {
	const res = await app.request(`/zoo/${SHORT_HASH}?noredirect=1`, {
		headers: { cookie: "fc_client=firefly|auto-on" },
	});
	expect(res.status).toBe(200);
	const body = await res.text();
	expect(body).not.toContain('data-auto="on"');
	expect(body).toContain("Auto-open: On");
});

test("POST /prefs merges the slug and sets the flag via Set-Cookie", async () => {
	const res = await app.request("/prefs", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			cookie: "fc_client=zoo|auto-off",
		},
		body: JSON.stringify({ auto: "on" }),
	});
	expect(res.status).toBe(204);
	const setCookie = res.headers.get("set-cookie") ?? "";
	// hono encodes "|" as %7C; parseClientCookie decodes it on read.
	expect(setCookie).toContain("fc_client=zoo%7Cauto-on");
	expect(setCookie).toContain("Max-Age=31536000");
	expect(setCookie).toContain("SameSite=Lax");

	const bad = await app.request("/prefs", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ auto: "sometimes" }),
	});
	expect(bad.status).toBe(400);
});

test("POST /prefs stores a 0–5s delay and keeps the other field", async () => {
	const delayOnly = await app.request("/prefs", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			cookie: "fc_client=zoo|auto-off",
		},
		body: JSON.stringify({ delay: 2 }),
	});
	expect(delayOnly.status).toBe(204);
	expect(delayOnly.headers.get("set-cookie") ?? "").toContain(
		"fc_client=zoo%7Cauto-off%7Cd2",
	);

	const autoOnly = await app.request("/prefs", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			cookie: "fc_client=zoo|auto-off|d2",
		},
		body: JSON.stringify({ auto: "on" }),
	});
	expect(autoOnly.status).toBe(204);
	expect(autoOnly.headers.get("set-cookie") ?? "").toContain(
		"fc_client=zoo%7Cauto-on%7Cd2",
	);

	const zero = await app.request("/prefs", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			cookie: "fc_client=zoo|auto-on",
		},
		body: JSON.stringify({ delay: 0 }),
	});
	expect(zero.status).toBe(204);
	expect(zero.headers.get("set-cookie") ?? "").toContain(
		"fc_client=zoo%7Cauto-on%7Cd0",
	);

	const backToDefault = await app.request("/prefs", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			cookie: "fc_client=zoo|auto-on|d2",
		},
		body: JSON.stringify({ delay: 5 }),
	});
	expect(backToDefault.status).toBe(204);
	const backCookie = backToDefault.headers.get("set-cookie") ?? "";
	expect(backCookie).toContain("fc_client=zoo%7Cauto-on");
	expect(backCookie).not.toContain("%7Cd");

	const tooHigh = await app.request("/prefs", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ delay: 6 }),
	});
	expect(tooHigh.status).toBe(400);
});

test("auto-open delay is read from the cookie", async () => {
	const two = await app.request(`/zoo/${SHORT_HASH}`, {
		headers: { cookie: "fc_client=firefly|auto-on|d2" },
	});
	expect(two.status).toBe(200);
	const twoBody = await two.text();
	expect(twoBody).toContain('data-auto-delay="2"');
	expect(twoBody).toContain('in <span class="auto-secs">2</span>s');

	const zero = await app.request(`/zoo/${SHORT_HASH}`, {
		headers: { cookie: "fc_client=firefly|d0" },
	});
	expect(zero.status).toBe(200);
	const zeroBody = await zero.text();
	expect(zeroBody).toContain('data-auto="unset"');
	expect(zeroBody).toContain('data-auto-delay="0"');
	expect(zeroBody).toContain("Opening <strong>Firefly</strong> now");
	expect(zeroBody).not.toContain('in <span class="auto-secs">0</span>s');

	// No delay segment → default 5s.
	const unset = await app.request(`/zoo/${SHORT_HASH}`, {
		headers: { cookie: "fc_client=firefly" },
	});
	expect(unset.status).toBe(200);
	expect(await unset.text()).toContain('data-auto-delay="5"');
});

test("PRIMARY_ORIGIN emits canonical + og:url on cast pages; unset emits neither", async () => {
	const canonicalRes = await app.request(`/zoo/${SHORT_HASH}`, undefined, {
		PRIMARY_ORIGIN: "https://forkcaster.xyz",
	});
	expect(canonicalRes.status).toBe(200);
	const canonicalBody = await canonicalRes.text();
	expect(canonicalBody).toContain(
		'<link rel="canonical" href="https://forkcaster.xyz/zoo/0x895ecc74" />',
	);
	expect(canonicalBody).toContain(
		'<meta property="og:url" content="https://forkcaster.xyz/zoo/0x895ecc74" />',
	);
	// Farcaster renders plain OG link cards (X-style) for forkcaster links:
	// og:site_name labels the card, and NO fc:miniapp/fc:frame tags ship —
	// those would turn shares into miniapp cards with launch friction.
	expect(canonicalBody).toContain(
		'<meta property="og:site_name" content="forkcaster" />',
	);
	expect(canonicalBody).toContain(
		'<meta property="og:type" content="article" />',
	);
	expect(canonicalBody).not.toContain("fc:miniapp");
	expect(canonicalBody).not.toContain("fc:frame");

	// No var (tests / bare workers.dev deploys): neither tag ships, byte
	// compatibility with the pre-dual-serve output.
	const plainRes = await app.request(`/zoo/${SHORT_HASH}`);
	const plainBody = await plainRes.text();
	expect(plainBody).not.toContain("canonical");
	expect(plainBody).not.toContain("og:url");
	expect(plainBody).not.toContain("fc:miniapp");
});
