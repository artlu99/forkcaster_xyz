/**
 * Channel route integration tests (PLAN5).
 *
 * Same contract as profile-route.test.ts: `app.request(...)`,
 * globalThis.fetch mocked and routed by exact URL — unexpected URLs throw,
 * which is how the zero-fetch gates (charset) are asserted. The channel
 * surface resolves entirely through the official Warpcast channel API
 * (api.farcaster.xyz/v1/channel): HTTP 200 {result:{channel}} is found,
 * HTTP 400 {errors:[…]} is the authoritative miss, everything else is
 * unreachable.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));
// CJS deps (linkify-react) call require("react"); sync preact/compat works.
mock.module("react", () => require("preact/compat"));
mock.module("react-dom", () => require("preact/compat"));
mock.module("react/jsx-runtime", () => require("preact/jsx-runtime"));
mock.module("react/jsx-dev-runtime", () => require("preact/jsx-runtime"));

const { app } = await import("./index.ts");

const CHANNEL_ID = "farcaster";
// Exactly what api.farcaster.xyz/v1/channel answers for a healthy channel
// (probed live Oct 2026) — including the empty externalLink and the
// engagement counts HTML must never render.
const CHANNEL = {
	id: CHANNEL_ID,
	url: "chain://eip155:7777777/erc721:0x4f86113fc3e9783cf3ec9a552cbb566716a57628",
	name: "Farcaster",
	description: "Discussions about Farcaster on Farcaster (meta!)",
	imageUrl: "https://imagedelivery.net/BXlu/51ffff68-4465/original",
	createdAt: 1691015606,
	followerCount: 445637,
	memberCount: 1,
	publicCasting: true,
	headerImageUrl: "https://imagedelivery.net/BXlu/064418ed-34b0/header",
	leadFid: 1,
	moderatorFids: [1],
	pinnedCastHash: "0x50184b62b4c52fd76628713562e1eda3dccaf63d",
	externalLink: { title: "", url: "" },
};
const FOUND = { result: { channel: CHANNEL } };
// The API's authoritative miss (HTTP 400), exactly as probed.
const MISS = { errors: [{ message: `No channel found with key ${CHANNEL_ID}` }] };

const originalFetch = globalThis.fetch;

function apiMock(
	routes: Record<string, { body: unknown; status?: number } | Error>,
): typeof fetch {
	return mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		const route = routes[url];
		if (route instanceof Error) throw route;
		if (route !== undefined) {
			return Response.json(route.body, { status: route.status ?? 200 });
		}
		throw new Error(`Unexpected fetch in test: ${url}`);
	}) as typeof fetch;
}

function defaultMock(): typeof fetch {
	return apiMock({
		[`https://api.farcaster.xyz/v1/channel?channelId=${CHANNEL_ID}`]: {
			body: FOUND,
		},
	});
}

beforeEach(() => {
	globalThis.fetch = defaultMock();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

// --- HTML: the identity card is the whole parsed entity -----------------------

test("channel page renders the identity card from the Warpcast API entity", async () => {
	const res = await app.request(`/channel/${CHANNEL_ID}`);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type") ?? "").toContain("text/html");

	const body = await res.text();
	// Card: name title, /id handle, banner + icon, description, facts.
	// Minimal key-form <title> (cast/profile convention); the rich form
	// rides on og:title.
	expect(body).toContain("<title>farcaster · forkcaster</title>");
	expect(body).toContain(">Farcaster</h1>");
	expect(body).toContain('class="channel-handle">/farcaster</p>');
	expect(body).toContain("Discussions about Farcaster on Farcaster (meta!)");
	expect(body).toContain(`src="${CHANNEL.imageUrl}"`);
	expect(body).toContain(`src="${CHANNEL.headerImageUrl}"`);
	expect(body).toContain("Created Aug 2, 2023");
	expect(body).toContain("lead fid 1");
	// Way out: the hand-verified trio — desktop sees Farcaster + Firefly,
	// phones additionally see Quorum (coarse-only; its web build has no
	// channel page). The channel's externalLink is empty ⇒ no fourth pill.
	expect(body).toContain(
		`href="https://farcaster.xyz/~/channel/${CHANNEL_ID}" data-scheme="farcaster://~/channel/${CHANNEL_ID}" data-intent="intent://~/channel/${CHANNEL_ID}#Intent;scheme=farcaster;package=com.farcaster.mobile;S.browser_fallback_url=https%3A%2F%2Ffarcaster.xyz%2F~%2Fchannel%2Ffarcaster;end">Farcaster</a>`,
	);
	expect(body).toContain(
		`href="https://firefly.social/channel/farcaster/${CHANNEL_ID}">Firefly</a>`,
	);
	expect(body).toContain(
		`class="pill coarse-only" href="https://www.quorummessenger.com/" data-scheme="quorummobile://feed?channelKey=${CHANNEL_ID}"`,
	);
	expect(body).toContain("package=com.quilibrium.quorummobile");
	// Firefly is web-only: no native attrs on its pill.
	expect(body).toContain(`>Firefly</a>`);
	expect(body).not.toContain('data-scheme="https://firefly.social');
	expect(body).not.toContain('rel="noopener noreferrer"');
	// Engagement counts are withheld from HTML (PLAN5 §5) — neither the
	// field name nor the raw numbers survive into the page.
	expect(body).not.toContain("followerCount");
	expect(body).not.toContain("445637");
	expect(body).not.toContain("memberCount");
	// parentUrl / pinnedCastHash / moderatorFids are JSON-twin data.
	expect(body).not.toContain("chain://");
	expect(body).not.toContain("0x50184b62");
	// og meta: website type, icon image, summary card (an icon is not a
	// cast embed image), description present.
	expect(body).toContain('<meta property="og:type" content="website" />');
	expect(body).toContain(
		'<meta property="og:title" content="Farcaster (/farcaster)" />',
	);
	expect(body).toContain(
		`<meta property="og:image" content="${CHANNEL.imageUrl}" />`,
	);
	expect(body).toContain(
		'<meta property="og:description" content="Discussions about Farcaster on Farcaster (meta!)" />',
	);
	expect(body).toContain('name="twitter:card" content="summary"');
	expect(body).not.toContain("summary_large_image");
	// HTML advertises the JSON twin.
	expect(body).toContain(
		'<link rel="alternate" type="application/json" href="?format=json" />',
	);
	// Waypoint law: exactly ONE script — the stateless DEEPLINK_SCRIPT for
	// the pill row's native attempts. "Don't remember or track" pinned
	// verbatim: no last-used cookie, no beacon, no auto-open anywhere.
	expect(body).toContain("(pointer: coarse)");
	expect((body.match(/<script/g) ?? []).length).toBe(1);
	expect(body).not.toContain("data-copy");
	expect(body).not.toContain("window.__fk");
	expect(body).not.toContain("sendBeacon");
	expect(body).not.toContain("data-client");
	expect(body).not.toContain("fc_client=");
	expect(body).not.toContain("data-auto");
	expect(body).not.toContain("farcaster.tv");
});

test("optional entity fields vanish instead of rendering empty", async () => {
	globalThis.fetch = apiMock({
		[`https://api.farcaster.xyz/v1/channel?channelId=${CHANNEL_ID}`]: {
			body: {
				result: {
					channel: {
						id: CHANNEL_ID,
						name: "Farcaster",
						imageUrl: CHANNEL.imageUrl,
					},
				},
			},
		},
	});
	const res = await app.request(`/channel/${CHANNEL_ID}`);
	expect(res.status).toBe(200);

	const body = await res.text();
	// No banner, no description, no facts row, no external pill.
	expect(body).not.toContain('class="channel-banner"');
	expect(body).not.toContain('<p class="channel-description">');
	expect(body).not.toContain('<ul class="channel-facts">');
	// og:description falls back to the honest default.
	expect(body).toContain(
		'<meta property="og:description" content="The /farcaster channel on Farcaster" />',
	);
});

test("an empty name falls back to the id (title, h1, og:title)", async () => {
	globalThis.fetch = apiMock({
		[`https://api.farcaster.xyz/v1/channel?channelId=${CHANNEL_ID}`]: {
			body: {
				result: {
					channel: { id: CHANNEL_ID, name: "", imageUrl: CHANNEL.imageUrl },
				},
			},
		},
	});
	const res = await app.request(`/channel/${CHANNEL_ID}`);
	const body = await res.text();
	expect(body).toContain("<title>farcaster · forkcaster</title>");
	expect(body).toContain(">farcaster</h1>");
	expect(body).toContain(
		'<meta property="og:title" content="farcaster (/farcaster)" />',
	);
});

test("a 200 payload without name/imageUrl renders the id fallbacks instead of 503", async () => {
	// The schema requires only the entity key: a thin-but-real channel is
	// found, and the renderer's designed fallbacks (id-as-name,
	// initial-block icon) take over — same semantics as empty strings.
	globalThis.fetch = apiMock({
		[`https://api.farcaster.xyz/v1/channel?channelId=${CHANNEL_ID}`]: {
			body: { result: { channel: { id: CHANNEL_ID } } },
		},
	});
	const res = await app.request(`/channel/${CHANNEL_ID}`);
	expect(res.status).toBe(200);

	const body = await res.text();
	expect(body).toContain("<title>farcaster · forkcaster</title>");
	expect(body).toContain(`<h1 class="channel-title">${CHANNEL_ID}</h1>`);
	expect(body).toContain("channel-avatar-fallback");
	expect(body).not.toContain('class="channel-banner"');
	expect(body).not.toContain('<meta property="og:image"');
});

test("a http(s) externalLink renders a second way-out pill; non-http(s) is dropped", async () => {
	const withLink = apiMock({
		[`https://api.farcaster.xyz/v1/channel?channelId=${CHANNEL_ID}`]: {
			body: {
				result: {
					channel: {
						...CHANNEL,
						externalLink: { title: "Farcaster site", url: "https://www.farcaster.xyz/" },
					},
				},
			},
		},
	});
	globalThis.fetch = withLink;
	const ok = await app.request(`/channel/${CHANNEL_ID}`);
	const okBody = await ok.text();
	expect(okBody).toContain(
		'href="https://www.farcaster.xyz/" target="_blank" rel="noopener noreferrer">Farcaster site</a>',
	);

	globalThis.fetch = apiMock({
		[`https://api.farcaster.xyz/v1/channel?channelId=${CHANNEL_ID}`]: {
			body: {
				result: {
					channel: {
						...CHANNEL,
						externalLink: { title: "evil", url: "javascript:alert(1)" },
					},
				},
			},
		},
	});
	const evil = await app.request(`/channel/${CHANNEL_ID}`);
	const evilBody = await evil.text();
	expect(evilBody).not.toContain("javascript:");
	expect(evilBody).not.toContain('rel="noopener noreferrer"');
});

test("both URL shapes render the same page; canonical always carries /~/channel/{id}", async () => {
	// The /~/ form is canonical — farcaster.xyz's own channel URL shape
	// (warpcast.com 301s there); /channel/{id} is the bare alias.
	const bare = await app.request(`/channel/${CHANNEL_ID}`, undefined, {
		PRIMARY_ORIGIN: "https://forkcaster.xyz",
	});
	expect(bare.status).toBe(200);
	const bareBody = await bare.text();
	expect(bareBody).toContain("Discussions about Farcaster on Farcaster (meta!)");
	expect(bareBody).toContain(
		`<link rel="canonical" href="https://forkcaster.xyz/~/channel/${CHANNEL_ID}" />`,
	);
	expect(bareBody).toContain(
		`<meta property="og:url" content="https://forkcaster.xyz/~/channel/${CHANNEL_ID}" />`,
	);

	const alias = await app.request(`/~/channel/${CHANNEL_ID}`);
	const aliasBody = await alias.text();
	expect(aliasBody).not.toContain("canonical");
	expect(aliasBody).not.toContain("og:url");
});

// --- Identity verdicts: strict statuses in BOTH variants ----------------------

test("API 400 miss ⇒ 404 (HTML and JSON)", async () => {
	globalThis.fetch = apiMock({
		[`https://api.farcaster.xyz/v1/channel?channelId=${CHANNEL_ID}`]: {
			body: MISS,
			status: 400,
		},
	});
	const html = await app.request(`/channel/${CHANNEL_ID}`);
	expect(html.status).toBe(404);
	expect(await html.text()).toContain("Channel not found");

	const json = await app.request(`/channel/${CHANNEL_ID}?format=json`);
	expect(json.status).toBe(404);
	expect(await json.json()).toEqual({ error: "channel not found" });
});

test("API 500 / network failure ⇒ 503 + Retry-After (HTML and JSON)", async () => {
	globalThis.fetch = apiMock({
		[`https://api.farcaster.xyz/v1/channel?channelId=${CHANNEL_ID}`]: {
			body: { errors: [{ message: "internal" }] },
			status: 500,
		},
	});
	const down = await app.request(`/channel/${CHANNEL_ID}`);
	expect(down.status).toBe(503);
	expect(down.headers.get("retry-after")).toBe("60");
	expect(await down.text()).toContain("temporarily unavailable");

	const json = await app.request(`/channel/${CHANNEL_ID}?format=json`);
	expect(json.status).toBe(503);
	expect(json.headers.get("retry-after")).toBe("60");
	expect(await json.json()).toEqual({
		error: "channel data temporarily unavailable",
	});

	globalThis.fetch = apiMock({
		[`https://api.farcaster.xyz/v1/channel?channelId=${CHANNEL_ID}`]:
			new Error("api unreachable"),
	});
	const thrown = await app.request(`/channel/${CHANNEL_ID}`);
	expect(thrown.status).toBe(503);
	expect(thrown.headers.get("retry-after")).toBe("60");
});

test("a malformed 200 body ⇒ 503 (service misbehaving, not an authoritative miss)", async () => {
	globalThis.fetch = apiMock({
		[`https://api.farcaster.xyz/v1/channel?channelId=${CHANNEL_ID}`]: {
			// Missing the required id/name/imageUrl identity — not parseable.
			body: { result: { channel: { followerCount: 1 } } },
		},
	});
	const res = await app.request(`/channel/${CHANNEL_ID}`);
	expect(res.status).toBe(503);
	expect(res.headers.get("retry-after")).toBe("60");
});

// --- Agent JSON twin ----------------------------------------------------------

test("?format=json returns the availability-gated channel body", async () => {
	const res = await app.request(`/channel/${CHANNEL_ID}?format=json`);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type") ?? "").toContain("application/json");

	const body = await res.json();
	expect(body.id).toBe(CHANNEL_ID);
	expect(body.name).toBe("Farcaster");
	expect(body.description).toBe(CHANNEL.description);
	expect(body.image).toBe(CHANNEL.imageUrl);
	expect(body.headerImage).toBe(CHANNEL.headerImageUrl);
	// unix-SECOND API timestamp → ISO, same convention as the profile twin.
	expect(body.createdAt).toBe(new Date(1691015606 * 1000).toISOString());
	expect(body.parentUrl).toBe(CHANNEL.url);
	expect(body.leadFid).toBe(1);
	expect(body.moderatorFids).toEqual([1]);
	// The engagement counts HTML withholds live here (PLAN5 §5).
	expect(body.followerCount).toBe(445637);
	expect(body.memberCount).toBe(1);
	expect(body.publicCasting).toBe(true);
	expect(body.pinnedCastHash).toBe("0x50184b62b4c52fd76628713562e1eda3dccaf63d");
	// The empty externalLink is absent, not a {title:"",url:""} stub.
	expect("externalLink" in body).toBe(false);
	expect(body.farcaster).toBe(`https://farcaster.xyz/~/channel/${CHANNEL_ID}`);
});

test("Accept: application/json negotiates JSON; */* stays HTML", async () => {
	const jsonRes = await app.request(`/channel/${CHANNEL_ID}`, {
		headers: { Accept: "application/json" },
	});
	expect(jsonRes.headers.get("content-type") ?? "").toContain(
		"application/json",
	);
	const anyRes = await app.request(`/channel/${CHANNEL_ID}`, {
		headers: { Accept: "*/*" },
	});
	expect(anyRes.headers.get("content-type") ?? "").toContain("text/html");
});

// --- Routing gates: registration order, charset, lowercase --------------------

test("garbage ids 404 with ZERO upstream fetches", async () => {
	let calls = 0;
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		calls++;
		throw new Error(`Unexpected fetch in test: ${String(input)}`);
	}) as typeof fetch;

	for (const path of [
		`/channel/${"a".repeat(31)}`, // over the id length gate
		`/channel/${encodeURIComponent("a b")}`, // space outside the charset
	]) {
		const res = await app.request(path);
		expect(res.status).toBe(404);
	}
	// Empty id: "channel" fits the username charset, so main's site-wide
	// trailing-slash policy owns this shape — 301 to /channel (which then
	// 404s at the profile route), still with zero upstream fetches.
	const slash = await app.request("/channel/");
	expect(slash.status).toBe(301);
	expect(slash.headers.get("location")).toBe("/channel");
	expect(calls).toBe(0);
});

test("channel trailing slashes 301 to the same shape minus the slash, search preserved", async () => {
	let calls = 0;
	globalThis.fetch = mock(async () => {
		calls++;
		throw new Error("Unexpected fetch in test");
	}) as typeof fetch;

	const plain = await app.request("/channel/Farcaster/?utm=x");
	expect(plain.status).toBe(301);
	expect(plain.headers.get("location")).toBe("/channel/farcaster?utm=x");

	const alias = await app.request(`/~/channel/${CHANNEL_ID}/`);
	expect(alias.status).toBe(301);
	expect(alias.headers.get("location")).toBe(`/~/channel/${CHANNEL_ID}`);

	expect(calls).toBe(0);
});

test("uppercase ids lowercase before lookup", async () => {
	const res = await app.request("/channel/Farcaster");
	expect(res.status).toBe(200);
	expect(await res.text()).toContain("Discussions about Farcaster on Farcaster (meta!)");
});

test("a hash-shaped id routes to the channel handler, not the cast route", async () => {
	// /channel/0xabc… is two segments and would match the cast route's
	// pattern — the literal-first-segment registration order must win.
	// The mock only knows the Warpcast API: any shim fetch (the cast
	// route's pipeline) would throw "Unexpected fetch" and fail the test.
	globalThis.fetch = apiMock({
		"https://api.farcaster.xyz/v1/channel?channelId=0xabc123": {
			body: MISS,
			status: 400,
		},
	});
	const res = await app.request("/channel/0xabc123");
	expect(res.status).toBe(404);
});

test("GET /api/ lists the channel JSON surface", async () => {
	const res = await app.request("/api/");
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.channel).toBe("/channel/{id}?format=json");
});

// --- Live-verified fixture: zora ----------------------------------------------
//
// Probed live Oct 2026: zora is the channel that exercises every optional
// branch at once — an externalLink (the second way-out pill farcaster and
// the other sampled channels never show), a multi-fid moderatorFids array,
// and non-trivial member/follower counts.

const ZORA = {
	id: "zora",
	url: "chain://eip155:1/erc721:0xca21d4228cdcc68d4e23807e5e370c07577dd152",
	name: "Zora",
	description: "Trade what's trending.",
	imageUrl: "https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/e49fbe15-894f-4918-1ecc-ee21c3e20800/original",
	createdAt: 1689888729,
	followerCount: 172438,
	memberCount: 682,
	publicCasting: true,
	headerImageUrl: "https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/4660d7d0-b412-4a05-4e64-8825a1523c00/original",
	leadFid: 8,
	moderatorFids: [8, 565025, 5952, 2558, 17129, 11245],
	externalLink: { title: "Join", url: "https://zora.co" },
};

function zoraMock(): typeof fetch {
	return apiMock({
		"https://api.farcaster.xyz/v1/channel?channelId=zora": {
			body: { result: { channel: ZORA } },
		},
	});
}

test("zora: external link renders the second pill; counts stay withheld", async () => {
	globalThis.fetch = zoraMock();
	const res = await app.request("/channel/zora");
	expect(res.status).toBe(200);

	const body = await res.text();
	// The channel's own way out, exactly as rendered live in prod QA.
	expect(body).toContain(
		'href="https://zora.co" target="_blank" rel="noopener noreferrer">Join</a>',
	);
	expect(body).toContain("lead fid 8");
	expect(body).toContain("Created Jul 20, 2023");
	// Engagement counts are a JSON-twin concern, never HTML surface.
	expect(body).not.toContain("172438");
	expect(body).not.toContain("682");
});

test("zora: JSON twin carries the full routing entity", async () => {
	globalThis.fetch = zoraMock();
	const res = await app.request("/channel/zora?format=json");
	expect(res.status).toBe(200);

	const body = await res.json();
	expect(body.id).toBe("zora");
	expect(body.parentUrl).toBe(
		"chain://eip155:1/erc721:0xca21d4228cdcc68d4e23807e5e370c07577dd152",
	);
	expect(body.leadFid).toBe(8);
	expect(body.moderatorFids).toEqual([8, 565025, 5952, 2558, 17129, 11245]);
	expect(body.memberCount).toBe(682);
	expect(body.followerCount).toBe(172438);
	expect(body.externalLink).toEqual({ title: "Join", url: "https://zora.co" });
	expect(body.createdAt).toBe(new Date(1689888729 * 1000).toISOString());
	expect(body.farcaster).toBe("https://farcaster.xyz/~/channel/zora");
});

// --- Escaping: hostile upstream fields never survive raw (XSS regression) -----

test("channel card escapes hostile upstream text", async () => {
	// name/description/imageUrl/headerImageUrl/externalLink are untrusted
	// upstream text rendered into h1, og/twitter attributes, img src, and
	// link attributes — same escaper as the cast/profile pages, pinned here
	// because the channel card is a new set of interpolation sites. Note:
	// the name never reaches <title> (the key-form title carries the id).
	globalThis.fetch = apiMock({
		[`https://api.farcaster.xyz/v1/channel?channelId=${CHANNEL_ID}`]: {
			body: {
				result: {
					channel: {
						id: CHANNEL_ID,
						name: `</title><script>alert(1)</script> & "quotes"`,
						description: `<b>bold</b> & 'single' "double"`,
						imageUrl: `https://img.test/x" onerror="alert(1)`,
						headerImageUrl: `https://img.test/y" onerror="alert(2)`,
						externalLink: {
							title: `"><svg onload="alert(3)">`,
							url: `https://evil.test/" onclick="alert(4)`,
						},
					},
				},
			},
		},
	});
	const res = await app.request(`/channel/${CHANNEL_ID}`);
	expect(res.status).toBe(200);

	const body = await res.text();
	// Nothing raw survives: the XSS vectors are gone, and the payloads may
	// only appear inside escaped attribute/element text (entities can't
	// break out).
	expect(body).not.toContain("<script>alert(1)");
	expect(body).not.toContain('" onerror=');
	expect(body).not.toContain("<b>bold</b>");
	expect(body).not.toContain('onclick="alert(4)');
	// h1 + og:title render the escaped form…
	expect(body).toContain(
		'<h1 class="channel-title">&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;</h1>',
	);
	expect(body).toContain('content="&lt;/title&gt;&lt;script&gt;');
	// …as do the description paragraph, the hostile img srcs, and the
	// external pill (https URL kept, its hostile quote payload inert).
	expect(body).toContain(
		"<p class=\"channel-description\">&lt;b&gt;bold&lt;/b&gt; &amp; &#39;single&#39; &quot;double&quot;</p>",
	);
	expect(body).toContain('src="https://img.test/x&quot; onerror=&quot;alert(1)"');
	expect(body).toContain('src="https://img.test/y&quot; onerror=&quot;alert(2)"');
	expect(body).toContain(
		'href="https://evil.test/&quot; onclick=&quot;alert(4)" target="_blank" rel="noopener noreferrer"',
	);
	expect(body).toContain(">&quot;&gt;&lt;svg onload=&quot;alert(3)&quot;&gt;</a>");
});
