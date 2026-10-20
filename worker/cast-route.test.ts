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
		{ url: "https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/0eeef320/original" },
	],
	timestamp: 1_792_425_174,
	user: {
		fid: 10215,
		username: "zoo",
		displayName: "zoo",
		pfpUrl: "https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/ab8e1aa9/original",
		bio: "primus amanuensis @qbase",
	},
};

const originalFetch = globalThis.fetch;

// decent-artlu's cast: same data, but fid 3319217 has NOT signed, and its
// URL embed has no unfurl mock — hostname fallback must still render.
const ARTLU_CAST = {
	...SHIM_CAST,
	fid: 3319217,
	embeds: [{ url: "https://example.com/article" }],
};
// fid with no /signed mock: its signed-check fetch throws (fail-open path).
// Its quote embed has no /h mock either: hydration fails, quote is dropped.
const UNKNOWN_SIGNED_CAST = {
	...SHIM_CAST,
	fid: 7777777,
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
		{ castId: { fid: 3854, hash: "0xa7c5f47033da848d6d16dac11c61838634a50c23" } },
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
			url === "https://shim.artlu.xyz/h/0xa7c5f47033da848d6d16dac11c61838634a50c23"
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
	expect(body).toContain(
		`https://firefly.social/post/farcaster/${FULL_HASH}`,
	);
	// URL embed unfurl failed (no mock) — hostname fallback still renders.
	expect(body).toContain("example.com");
	// ...but the registry's requiresSigned clients (farcaster) are suppressed.
	expect(body).not.toContain('data-client="farcaster"');
	expect(body).not.toContain(
		"https://farcaster.xyz/decent-artlu/0xbb54368f",
	);
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
	// The GitHub mark comes from the simple-icons dependency (no hand-inlined
	// SVG), and the wording states the MIT license.
	expect(footer).toContain("<svg");
	expect(footer).toContain("MIT");
	expect(footer).not.toContain(">source<");
	// Next to it: the contributing guide, with its own GitHub Sponsors mark.
	expect(footer).toContain("CONTRIBUTING.md");
	expect(footer).toContain("Contributing");
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
	expect(body).toContain("/logos/farcaster.svg");
	expect(body).toContain("/logos/firefly.png");
	expect(body).toContain("/logos/neynar.png");
	// Per-cast templates interpolate.
	expect(body).toContain(`href="https://farcaster.xyz/zoo/${SHORT_HASH}"`);
	expect(body).toContain(
		`href="https://firefly.social/post/farcaster/${FULL_HASH}"`,
	);
	// Format verified against fc-clients-cast-action: full-hash based.
	expect(body).toContain(`href="https://explorer.neynar.com/${FULL_HASH}"`);
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
