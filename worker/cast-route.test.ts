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
// NOTE: the REAL decent-artlu/0xbb54368f is quote-only (no URL embeds) —
// the canonical no-external-links cast for the link gate. This fixture
// deliberately models a URL embed to exercise the unfurl fallback path.
// The hash matches its route: the race's central validation rejects any
// found cast that doesn't resolve the requested hash.
const ARTLU_HASH = "0xbb54368fa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
const ARTLU_CAST = {
	...SHIM_CAST,
	fid: 3319217,
	hash: ARTLU_HASH,
	embeds: [{ url: "https://example.com/article" }],
};
// The canonical external-link cast (fid 2210, signed): one x.com URL
// embed — exactly the shape a links-only client exists to serve.
const KENNY_CAST = {
	fid: 2210,
	hash: "0xa26d1f3861326cf24977995ec9dd24145e87a2fb",
	text: "gold getting cracked by AI before Bitcoin would be pretty funny\n\nhttps://x.com/MarathonFusion/status/2113001073019662481",
	embeds: [{ url: "https://x.com/MarathonFusion/status/2113001073019662481" }],
	timestamp: 1_792_683_778,
	user: {
		fid: 2210,
		username: "kenny",
		displayName: "kenny",
		pfpUrl:
			"https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/0d23c0b3-a56e-45e0-f97c-80b6c251c900/original",
		bio: "the coordination protocol - /poidh - @poidhbot",
	},
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
		if (url === "https://shim.artlu.xyz/wc/kenny/0xa26d1f38") {
			return Response.json({ success: true, cast: KENNY_CAST });
		}
		if (url === "https://shim.artlu.xyz/signed/2210") {
			return Response.json({ success: true, signed: true });
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

test("GET /api/ returns the agent-facing index", async () => {
	const res = await app.request("/api/");
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual({
		cast: "/{username}/{hash}?format=json",
		profile: "/{username}?format=json",
		channel: "/~/channel/{id}?format=json",
		raceStats: "/race-stats.json",
		transparency: "/transparency?format=json",
	});
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
	// Quorum (native scheme, no requiresSigned) still renders — its
	// quorummobile:// pill ships data-scheme and the deeplink script.
	expect(body).toContain("quorummobile://");
	// farcaster itself contributes no native target on this page.
	expect(body).not.toContain("farcaster://");
	expect(body).toContain("pointer: coarse");
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

// The username route param arrives percent-decoded — it must never reach
// HTML raw (regression: reflected <script> in the 404 body and </title>
// breakout on cast pages).
test("404 page escapes the percent-decoded username (XSS regression)", async () => {
	globalThis.fetch = mock(async () => Response.json({ success: false }));
	const payload = encodeURIComponent("<script>alert(1)</script>");
	const res = await app.request(`/${payload}/0xdeadbeef`);
	expect(res.status).toBe(404);

	const body = await res.text();
	expect(body).not.toContain("<script>alert(1)");
	expect(body).toContain(
		"Cast not found: &lt;script&gt;alert(1)&lt;/script&gt;/0xdeadbeef",
	);
});

test("cast page <title> escapes the percent-decoded username (XSS regression)", async () => {
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("shim.artlu.xyz/wc/")) {
			return Response.json({
				success: true,
				cast: {
					...SHIM_CAST,
					hash: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
				},
			});
		}
		return new Response("", { status: 404 });
	});
	const payload = encodeURIComponent("</title><script>alert(1)</script>");
	const res = await app.request(`/${payload}/0xdeadbeef`);
	expect(res.status).toBe(200);

	const body = await res.text();
	// The payload must stay escaped inside <title>, never close it early.
	expect(body).not.toContain("</title><script>");
	expect(body).toContain("<title>&lt;/title&gt;&lt;script&gt;");
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
// The action row is rendered from worker/client-registry.ts: one pill per
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
	// (0x optional) — emitted BARE, no 0x, matching the client's internal
	// lowercase-hex lookups.
	expect(body).toContain(`href="https://quilcast.com/c/${FULL_HASH.slice(2)}"`);
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
	// counters became one entry per counter when click-through tracking
	// shipped (declared shape change) — both entries keep the negative list.
	expect(json.tracking.counters.pageLoad).toContain("No cast IDs");
	expect(json.tracking.counters.clientChoice).toContain("No cast IDs");
	expect(json.clientRank.status).toBe("coming-soon");

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

test("auto-open for a scheme-only client carries native targets (quorum)", async () => {
	// quorum's web href is a homepage stub — the redirect must attempt the
	// app first. The banner carries the server-resolved native targets for
	// AUTO_SCRIPT's timer-driven open, and the countdown's anchor carries
	// data-scheme so DEEPLINK_SCRIPT handles manual taps too.
	const res = await app.request(`/zoo/${SHORT_HASH}`, {
		headers: { cookie: "fc_client=quorum" },
	});
	expect(res.status).toBe(200);
	const body = await res.text();
	expect(body).toContain('data-auto="unset"');
	expect(body).toContain(
		'data-auto-scheme="quorummobile://feed?castHashPrefix=0x895ecc7415208bfb6105a8cb675f391f19cb9e2c&amp;username=zoo"',
	);
	expect(body).toContain(
		'data-auto-intent="intent://feed?castHashPrefix=0x895ecc7415208bfb6105a8cb675f391f19cb9e2c&amp;username=zoo#Intent;scheme=quorummobile;package=com.quilibrium.quorummobile;S.browser_fallback_url=https%3A%2F%2Fwww.quorummessenger.com%2F;end"',
	);
	// The countdown anchor is client-rendered (apply("countdown") builds
	// the banner), so only AUTO_SCRIPT's wiring is visible in the raw HTML.
	expect(body).toContain(`' data-scheme="' + schemeAttr + '"'`);
	expect(body).toContain(`' data-intent="' + intentAttr + '"` + `'`);
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
	// Canonical carries the resolved FULL hash: short/long variants of the
	// same cast dedupe onto one URL (the JSON renderer and MCP tool
	// advertise the same form).
	expect(canonicalBody).toContain(
		`<link rel="canonical" href="https://forkcaster.xyz/zoo/${FULL_HASH}" />`,
	);
	expect(canonicalBody).toContain(
		`<meta property="og:url" content="https://forkcaster.xyz/zoo/${FULL_HASH}" />`,
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

test("GET /mcp: server card for browsers, 405 for SSE probes", async () => {
	// Browsers and link crawlers (no event-stream in Accept) get the
	// OG-tagged server card; MCP clients probing for SSE get protocol 405.
	const res = await app.request("/mcp", { headers: { accept: "text/html" } });
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type") ?? "").toContain("text/html");
	const body = await res.text();
	expect(body).toContain('property="og:title"');
	expect(body).toContain("get_cast_link");
	// og:image rides along for share-friendly unfurls.
	expect(body).toContain('content="https://forkcaster.xyz/mcp-card.png"');
	expect(body).toContain('content="summary_large_image"');

	const sse = await app.request("/mcp", {
		headers: { accept: "text/event-stream" },
	});
	expect(sse.status).toBe(405);
	expect(sse.headers.get("allow")).toBe("POST");
});

// --- POST /t: client click-through telemetry (PLAN3) ---

type DataPoint = { indexes?: unknown[]; blobs?: unknown[]; doubles?: unknown[] };

function trackEnv(calls: DataPoint[]) {
	return {
		CLICK_STATS: {
			writeDataPoint: (dp: DataPoint) => {
				calls.push(dp);
			},
		},
	} as unknown as Env;
}

function trackCtx(): {
	ctx: { waitUntil: (p: Promise<unknown>) => void };
	waited: Promise<unknown>[];
} {
	const waited: Promise<unknown>[] = [];
	return {
		ctx: {
			waitUntil: (p: Promise<unknown>) => {
				waited.push(p);
			},
		},
		waited,
	};
}

test("POST /t records a valid pill event exactly once, 204 always", async () => {
	const calls: DataPoint[] = [];
	const { ctx, waited } = trackCtx();
	const res = await app.request(
		"/t",
		{
			method: "POST",
			body: JSON.stringify({
				c: "firefly",
				k: "pill",
				t: "native",
				d: "coarse",
				f: "switch",
			}),
		},
		trackEnv(calls),
		ctx,
	);
	expect(res.status).toBe(204);
	expect(await res.text()).toBe("");
	await Promise.all(waited);
	expect(calls).toHaveLength(1);
	expect(calls[0].indexes).toEqual(["firefly"]);
	expect(calls[0].blobs).toEqual([
		"pill:native",
		"coarse",
		"switch",
		"localhost",
		"cast",
	]);
});

test("POST /t drops everything off the allow-list — 204, zero rows", async () => {
	const calls: DataPoint[] = [];
	const { ctx } = trackCtx();
	const bodies = [
		"not json",
		JSON.stringify({ c: "not-a-client", k: "pill" }),
		JSON.stringify({ c: "firefly", k: "hover" }),
		JSON.stringify({ c: "firefly" }),
		JSON.stringify({ c: "firefly", k: "pill" }).slice(0, 40) + "x".repeat(200),
		"", // empty body
	];
	for (const body of bodies) {
		const res = await app.request(
			"/t",
			{ method: "POST", body },
			trackEnv(calls),
			ctx,
		);
		expect(res.status).toBe(204);
	}
	expect(calls).toHaveLength(0);
});

test("POST /t without the binding or an executionCtx still 204s (best-effort)", async () => {
	// No CLICK_STATS binding (bare workers.dev deploys, some tests):
	const res = await app.request("/t", {
		method: "POST",
		body: JSON.stringify({ c: "firefly", k: "pill" }),
	});
	expect(res.status).toBe(204);
});

test("cast pages ship the track helper; auto-open banners carry the slug", async () => {
	const res = await app.request(`/zoo/${SHORT_HASH}`);
	expect(res.status).toBe(200);
	const body = await res.text();
	// TRACK_SCRIPT (the definition) precedes the scripts that call it.
	expect(body.indexOf("window.__fk = function")).toBeGreaterThanOrEqual(0);
	expect(body.indexOf("window.__fk = function")).toBeLessThan(
		body.indexOf("window.__fk({"),
	);
	expect(body).toContain('sendBeacon("/t"');
	expect(body).toContain("(pointer: coarse)");
	// No cast identifiers anywhere in the telemetry path: the track helper
	// never references username/hash variables.
	const track = body.slice(
		body.indexOf("window.__fk = function"),
		body.indexOf("</script>", body.indexOf("window.__fk = function")),
	);
	expect(track).not.toContain("username");
	expect(track).not.toContain("hash");

	// Auto-open banners carry the real slug (data-auto-client is the
	// display title — "Farcaster" ≠ "farcaster").
	const autoRes = await app.request(`/zoo/${SHORT_HASH}`, {
		headers: { Cookie: "fc_client=farcaster|auto-on" },
	});
	const autoBody = await autoRes.text();
	expect(autoBody).toContain('data-auto-slug="farcaster"');
	expect(autoBody).toContain('data-auto-client="Farcaster"');
});

// --- rank-ordered pill row (PLAN3 §6) ---

const RANK_SNAPSHOT = {
	v: 1,
	generatedAt: "2026-10-23T00:00:00.000Z",
	window: { hours: 168 },
	sampled: false,
	total: 250,
	warmingUp: false,
	rows: [
		{
			id: "firefly",
			first: 10,
			switched: 2,
			repeat: 5,
			pill: 17,
			goNow: 3,
			auto: 20,
			score: 21.4,
			share: 60.1,
		},
		{
			id: "farcaster",
			first: 1,
			switched: 0,
			repeat: 1,
			pill: 2,
			goNow: 0,
			auto: 4,
			score: 1.7,
			share: 4.8,
		},
	],
};

test("rank snapshot reorders pills (never hides); null keeps registry order", async () => {
	const { resetClientRankStore } = await import("./client-rank-store.ts");
	try {
		// lmdis serves the rank snapshot; shim serves the cast.
		globalThis.fetch = mock(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "https://lmdis.test") {
				return Response.json({ result: JSON.stringify(RANK_SNAPSHOT) });
			}
			if (url === `https://shim.artlu.xyz/wc/zoo/${SHORT_HASH}`) {
				return Response.json({ success: true, cast: SHIM_CAST });
			}
			if (url === "https://shim.artlu.xyz/signed/10215") {
				return Response.json({ success: true, signed: true });
			}
			throw new Error(`Unexpected fetch in test: ${url}`);
		}) as typeof fetch;
		resetClientRankStore();
		const env = { LMDIS_URL: "https://lmdis.test", LMDIS_REST_TOKEN: "tok" };
		const ranked = await app.request(`/zoo/${SHORT_HASH}`, {}, env);
		const rankedBody = await ranked.text();
		// firefly (score 21.4) now precedes farcaster (1.7)…
		expect(rankedBody.indexOf('data-client="firefly"')).toBeLessThan(
			rankedBody.indexOf('data-client="farcaster"'),
		);
		// …but every client still renders — reordered, never hidden.
		// (linkcast is legitimately absent: the house cast is link-less, so
		// the external-link gate hides it — the gate test below covers it.)
		for (const id of [
			"farcaster",
			"quorum",
			"firefly",
			"neynar",
			"quilcast",
			"vibeshift",
		]) {
			expect(rankedBody).toContain(`data-client="${id}"`);
		}
		// The badge still follows the cookie, not the rank.
		const fireflyPill = rankedBody.slice(
			rankedBody.indexOf('data-client="firefly"'),
		);
		expect(fireflyPill.slice(0, fireflyPill.indexOf("</a>"))).not.toContain(
			"last used",
		);

		// No env (tests / bare deploys): registry order, byte-comparable.
		resetClientRankStore();
		const plain = await app.request(`/zoo/${SHORT_HASH}`);
		const plainBody = await plain.text();
		expect(plainBody.indexOf('data-client="farcaster"')).toBeLessThan(
			plainBody.indexOf('data-client="firefly"'),
		);
	} finally {
		resetClientRankStore();
	}
});

// The external-link gate, end to end, against the canonical casts:
// linkcast — the roster's one requiresExternalLinks client, gated by the
// links-only contract (see the registry comment) — renders its pill only
// on casts that carry an external URL embed. kenny/0xa26d1f38 is the
// canonical with-link cast (one x.com embed, signed author);
// zoo/0x895ecc74 is the house cast (image-only — genuinely link-less;
// the REAL no-external canonical is decent-artlu/0xbb54368f, quote-only,
// but its route fixture models a URL embed for the unfurl-fallback path,
// so it can't play this role).
test("link gate: linkcast pill only on casts with an external link", async () => {
	// Image-only cast: nothing external ⇒ pill hidden.
	const noLinks = await app.request("/zoo/0x895ecc74");
	expect(noLinks.status).toBe(200);
	expect(await noLinks.text()).not.toContain('data-client="linkcast"');

	// Cast with an external URL embed ⇒ pill offered.
	const withLink = await app.request("/kenny/0xa26d1f38");
	expect(withLink.status).toBe(200);
	const body = await withLink.text();
	expect(body).toContain('data-client="linkcast"');
	// {fullHashRaw} of kenny's cast, bare hex, no 0x.
	expect(body).toContain(
		'href="https://linkcast.xyz/cast/a26d1f3861326cf24977995ec9dd24145e87a2fb"',
	);
});
