/**
 * Profile route integration tests.
 *
 * Same contract as cast-route.test.ts: `app.request(...)`, globalThis.fetch
 * mocked and routed by exact shim URL — unexpected URLs throw, which is how
 * the zero-fetch gates (denylist, charset) are asserted. The profile surface
 * resolves entirely through shim: /f/{username} (identity verdict),
 * /user/{fid} (hydrated entity), /{username}/casts-and-replies (timeline).
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));
// CJS deps (linkify-react) call require("react"); sync preact/compat works.
mock.module("react", () => require("preact/compat"));
mock.module("react-dom", () => require("preact/compat"));
mock.module("react/jsx-runtime", () => require("preact/jsx-runtime"));
mock.module("react/jsx-dev-runtime", () => require("preact/jsx-runtime"));

const { app } = await import("./index.ts");

const USERNAME = "decent-artlu";
const FID = 3319217;
const ADDRESS = "0xea51dDf4d06fdc5cD6564380FA8d05329edfDaD6";
const CAST_HASH = "0x3ceab47a5990cce65e0116e32dec0aacfdf4aed1";
const REPLY_HASH = "0x74bb59de263462839fe10e4683bd20e432649ffc";
const CAST_TS = 1_792_781_202;

// Hydrated entity, exactly as shim /user/{fid} answers (probed Oct 2026).
const USER = {
	fid: FID,
	username: USERNAME,
	displayName: "Ultra",
	pfpUrl: "https://cdn.artlu.xyz/2R6cZrpTizY",
	bio: "Bass Ackwards. https://decent-artlu.farchiver.xyz/browse/decent-artlu/",
	primaryAddress: ADDRESS,
	proNft: null,
};
// Timeline rows, exactly as /{username}/casts-and-replies answers: canonical
// ShimCast rows (unix-SECOND timestamps, no inline user) + parentCastId on
// replies. One text cast, one image-only reply.
const CASTS = {
	success: true,
	casts: [
		{
			fid: FID,
			hash: CAST_HASH,
			text: "related: I see people with their batteries of pre-commit hooks",
			timestamp: CAST_TS,
			embeds: [],
		},
		{
			fid: FID,
			hash: REPLY_HASH,
			text: "",
			timestamp: 1_792_000_000,
			embeds: [{ url: "https://imagedelivery.net/BXlu/abc/original" }],
			parentCastId: { fid: FID, hash: REPLY_HASH },
		},
	],
};

const originalFetch = globalThis.fetch;

function shimMock(
	routes: Record<string, unknown | Error>,
): typeof fetch {
	return mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		const route = routes[url];
		if (route instanceof Error) throw route;
		if (route !== undefined) return Response.json(route);
		throw new Error(`Unexpected fetch in test: ${url}`);
	}) as typeof fetch;
}

function defaultMock(): typeof fetch {
	return shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: { success: true, user: USER },
		[`https://shim.artlu.xyz/signed/${FID}`]: {
			success: true,
			signed: true,
		},
		[`https://shim.artlu.xyz/${USERNAME}/casts-and-replies?limit=10`]: CASTS,
	});
}

beforeEach(() => {
	globalThis.fetch = defaultMock();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

// --- HTML: the identity card is the whole hydrated entity --------------------

test("profile page renders the full hydrated entity as the identity card", async () => {
	const res = await app.request(`/${USERNAME}`);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type") ?? "").toContain("text/html");

	const body = await res.text();
	// Card: displayName title, handle, avatar, bio, fid.
	// Minimal key-form <title> (cast-page convention); the rich form rides
	// on og:title.
	expect(body).toContain("<title>decent-artlu · forkcaster</title>");
	expect(body).toContain("@decent-artlu");
	expect(body).toContain("Bass Ackwards.");
	// Bio URLs linkify (owner-approved exception to the plain-text bio):
	// the URL is href and its own text, new tab, noopener.
	expect(body).toContain(
		'<a href="https://decent-artlu.farchiver.xyz/browse/decent-artlu/" target="_blank" rel="noopener">https://decent-artlu.farchiver.xyz/browse/decent-artlu/</a>',
	);
	expect(body).toContain(`src="${USER.pfpUrl}"`);
	expect(body).toContain(`fid ${FID}`);
	// Address: truncated display, full address in title + copy payload,
	// opinionated Basescan link.
	expect(body).toContain(">0xea51…DaD6</code>");
	expect(body).toContain(`title="${ADDRESS}"`);
	expect(body).toContain(`data-copy="${ADDRESS}"`);
	expect(body).toContain(`href="https://basescan.org/address/${ADDRESS}"`);
	// proNft is typed but never rendered (no known shape).
	expect(body).not.toContain("proNft");
	// Waypoint law, strict dial: NO cast list on the identity card — the
	// list lives on /{username}/casts-and-replies, one pill away.
	expect(body).toContain(
		`href="/${USERNAME}/casts-and-replies">Casts and replies</a>`,
	);
	expect(body).not.toContain("Recent casts");
	expect(body).not.toContain('class="profile-cast"');
	// The identity card skips the timeline call entirely (only /f + /user).
	const fetchMock = globalThis.fetch as ReturnType<typeof mock>;
	expect(
		fetchMock.mock.calls.every((c) =>
			!String(c[0]).includes("casts-and-replies"),
		),
	).toBe(true);
	// OG meta: profile type, summary card (avatar is not a cast image).
	expect(body).toContain('<meta property="og:type" content="profile" />');
	expect(body).toContain(
		'<meta property="og:title" content="Ultra (@decent-artlu)" />',
	);
	expect(body).toContain(`<meta property="og:image" content="${USER.pfpUrl}" />`);
	expect(body).toContain('name="twitter:card" content="summary"');
	expect(body).not.toContain("summary_large_image");
	// HTML advertises the JSON twin.
	expect(body).toContain(
		'<link rel="alternate" type="application/json" href="?format=json" />',
	);
	// Waypoint law: the identity card is the page. The stateful layer
	// ships the menu + scripts; still no auto-open for a
	// cookieless visitor, no feed reading, no engagement surface.
	expect(body).toContain("data-copy");
	expect(body).toContain("window.__fk");
	expect(body).toContain('data-client="farcaster" data-kind="profile"');
	expect(body).not.toContain("data-auto");
	expect(body).not.toContain("farcaster.tv");
});

test("profile bio linkifies explicit URLs; punctuation, graph tokens, and hostile URLs stay inert", async () => {
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: {
			success: true,
			user: {
				fid: FID,
				username: USERNAME,
				displayName: "Ultra",
				pfpUrl: USER.pfpUrl,
				bio: `find me at https://example.com/path. also @friend and #channel, or (https://nested.test/x) — and https://evil.test/" onmouseover="alert(1)`,
			},
		},
		[`https://shim.artlu.xyz/${USERNAME}/casts-and-replies?limit=10`]: CASTS,
	});
	const res = await app.request(`/${USERNAME}`);
	expect(res.status).toBe(200);

	const body = await res.text();
	const bioStart = body.indexOf('<p class="profile-bio">');
	const bioEnd = body.indexOf("</p>", bioStart) + 4;
	const bio = body.slice(bioStart, bioEnd);

	// Trailing period is NOT part of the link; the parenthesized URL keeps
	// its closing paren outside the anchor.
	expect(bio).toContain(
		'<a href="https://example.com/path" target="_blank" rel="noopener">https://example.com/path</a>.',
	);
	expect(bio).toContain(
		'(<a href="https://nested.test/x" target="_blank" rel="noopener">https://nested.test/x</a>)',
	);
	// Mentions/channels are graph features — they stay inert plain text.
	expect(bio).toContain("also @friend and #channel");
	// Exactly the three safe anchors in the bio.
	expect((bio.match(/<a /g) ?? []).length).toBe(3);
	// The hostile URL is inert: quote payload never breaks the attribute.
	expect(bio).not.toContain('" onmouseover=');
	expect(bio).toContain('href="https://evil.test/" target="_blank"');
});

test("profile page emits canonical + og:url under PRIMARY_ORIGIN, neither without", async () => {
	const canonical = await app.request(`/${USERNAME}`, undefined, {
		PRIMARY_ORIGIN: "https://forkcaster.xyz",
	});
	const canonicalBody = await canonical.text();
	expect(canonicalBody).toContain(
		`<link rel="canonical" href="https://forkcaster.xyz/${USERNAME}" />`,
	);
	expect(canonicalBody).toContain(
		`<meta property="og:url" content="https://forkcaster.xyz/${USERNAME}" />`,
	);

	const plain = await app.request(`/${USERNAME}`);
	const plainBody = await plain.text();
	expect(plainBody).not.toContain("canonical");
	expect(plainBody).not.toContain("og:url");
});

test("optional entity fields vanish instead of rendering empty", async () => {
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: {
			success: true,
			user: { fid: FID, username: USERNAME, displayName: null, bio: null },
		},
		[`https://shim.artlu.xyz/${USERNAME}/casts-and-replies?limit=10`]: {
			success: true,
			casts: [],
		},
	});
	const res = await app.request(`/${USERNAME}`);
	expect(res.status).toBe(200);

	const body = await res.text();
	// displayName falls back to the handle everywhere (title, h1, og:title);
	// no avatar img without pfpUrl; no bio paragraph.
	expect(body).toContain("<title>decent-artlu · forkcaster</title>");
	expect(body).toContain("<h1 class=\"profile-title\">@decent-artlu</h1>");
	// No avatar img without pfpUrl — the CSS initial-block renders instead.
	expect(body).not.toContain("<img class=\"profile-avatar\"");
	expect(body).toContain("profile-avatar-fallback");
	// No bio paragraph (the class appears in the <style> block regardless).
	expect(body).not.toContain('<p class="profile-bio">');
	expect(body).toContain(
		'<meta property="og:description" content="Casts from @decent-artlu on Farcaster" />',
	);
	// No address facts without primaryAddress (match the row, not the CSS
	// class name in the <style> block).
	expect(body).not.toContain('<li class="profile-address">');
});

test("a malformed primaryAddress renders as bare text — no copy, no explorer", async () => {
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: {
			success: true,
			user: { ...USER, primaryAddress: "not-an-address" },
		},
		[`https://shim.artlu.xyz/${USERNAME}/casts-and-replies?limit=10`]: CASTS,
	});
	const res = await app.request(`/${USERNAME}`);
	expect(res.status).toBe(200);

	const body = await res.text();
	expect(body).toContain("not-an-address");
	// No copy button, no explorer — but the copy script may still ship.
	expect(body).not.toContain('class="profile-copy"');
	expect(body).not.toContain("basescan.org");
});

// --- Identity verdicts: strict statuses in BOTH variants ----------------------

test("shim /f miss ⇒ 404 (HTML and JSON)", async () => {
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true },
	});
	const html = await app.request(`/${USERNAME}`);
	expect(html.status).toBe(404);
	expect(await html.text()).toContain("Profile not found");

	const json = await app.request(`/${USERNAME}?format=json`);
	expect(json.status).toBe(404);
	expect(await json.json()).toEqual({ error: "profile not found" });
});

test("sparse /user shape (username null) ⇒ 404 — shim contradicting its own /f", async () => {
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: {
			success: true,
			user: {
				fid: FID,
				username: null,
				displayName: null,
				pfpUrl: null,
				bio: null,
				primaryAddress: null,
				proNft: null,
			},
		},
	});
	const res = await app.request(`/${USERNAME}`);
	expect(res.status).toBe(404);
});

test("shim unreachable ⇒ 503 + Retry-After (HTML error page; JSON error body)", async () => {
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: new Error("shim unavailable"),
	});
	const html = await app.request(`/${USERNAME}`);
	expect(html.status).toBe(503);
	expect(html.headers.get("retry-after")).toBe("60");
	expect(await html.text()).toContain("temporarily unavailable");

	const json = await app.request(`/${USERNAME}?format=json`);
	expect(json.status).toBe(503);
	expect(json.headers.get("retry-after")).toBe("60");
	expect(await json.json()).toEqual({
		error: "profile data temporarily unavailable",
	});
});

// --- Timeline fails soft: never a 404 once identity is proven -----------------

test("identity call retries once on a shim blip, then renders", async () => {
	let fidCalls = 0;
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === `https://shim.artlu.xyz/f/${USERNAME}`) {
			fidCalls++;
			if (fidCalls === 1) throw new Error("transient blip");
			return Response.json({ success: true, fid: FID });
		}
		if (url === `https://shim.artlu.xyz/user/${FID}`) {
			return Response.json({ success: true, user: USER });
		}
		if (url === `https://shim.artlu.xyz/signed/${FID}`) {
			return Response.json({ success: true, signed: true });
		}
		throw new Error(`Unexpected fetch in test: ${url}`);
	}) as typeof fetch;
	const res = await app.request(`/${USERNAME}`);
	expect(res.status).toBe(200);
	expect(fidCalls).toBe(2);
	expect(await res.text()).toContain("Bass Ackwards.");
});

test("/f HTTP 500 is an outage (503 after retry), never a false 404", async () => {
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		if (String(input) === `https://shim.artlu.xyz/f/${USERNAME}`) {
			return new Response("boom", { status: 500 });
		}
		throw new Error(`Unexpected fetch in test: ${String(input)}`);
	}) as typeof fetch;
	const json = await app.request(`/${USERNAME}?format=json`);
	expect(json.status).toBe(503);
	expect(json.headers.get("retry-after")).toBe("60");
	expect(await json.json()).toEqual({
		error: "profile data temporarily unavailable",
	});
});

test("timeline failure fails soft: JSON carries the note, the identity page is untouched", async () => {
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: { success: true, user: USER },
		[`https://shim.artlu.xyz/${USERNAME}/casts-and-replies?limit=10`]: {
			success: false,
			error: "getHubFidByUsername: User not found",
		},
	});
	const json = await app.request(`/${USERNAME}?format=json`);
	const data = await json.json();
	expect(data.note).toBe("timeline unavailable");
	expect("casts" in data).toBe(false);

	// The identity page never fetched the timeline, so it never mentions it.
	const html = await app.request(`/${USERNAME}`);
	expect(html.status).toBe(200);
	expect(await html.text()).not.toContain("unavailable right now");
});

// --- Agent JSON twin ----------------------------------------------------------

test("?format=json returns the availability-gated profile body", async () => {
	const res = await app.request(`/${USERNAME}?format=json`);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type") ?? "").toContain("application/json");

	const body = await res.json();
	expect(body.username).toBe(USERNAME);
	expect(body.fid).toBe(FID);
	expect(body.displayName).toBe("Ultra");
	expect(body.bio).toBe(
		"Bass Ackwards. https://decent-artlu.farchiver.xyz/browse/decent-artlu/",
	);
	expect(body.pfp).toBe(USER.pfpUrl);
	expect(body.primaryAddress).toBe(ADDRESS);
	// unix-SECOND shim timestamps → ISO, same convention as the cast JSON.
	expect(body.casts).toEqual([
		{
			hash: CAST_HASH,
			text: CASTS.casts[0].text,
			timestamp: new Date(CAST_TS * 1000).toISOString(),
			url: `http://localhost/${USERNAME}/${CAST_HASH}`,
		},
		{
			hash: REPLY_HASH,
			timestamp: new Date(1_792_000_000 * 1000).toISOString(),
			url: `http://localhost/${USERNAME}/${REPLY_HASH}`,
		},
	]);
	expect(body.farcaster).toBe(`https://farcaster.xyz/${USERNAME}`);
	// ok timeline: no note. proNft: typed, never emitted.
	expect("note" in body).toBe(false);
	expect("proNft" in body).toBe(false);
});

test("Accept: application/json negotiates JSON; */* stays HTML", async () => {
	const jsonRes = await app.request(`/${USERNAME}`, {
		headers: { Accept: "application/json" },
	});
	expect(jsonRes.headers.get("content-type") ?? "").toContain(
		"application/json",
	);
	const anyRes = await app.request(`/${USERNAME}`, {
		headers: { Accept: "*/*" },
	});
	expect(anyRes.headers.get("content-type") ?? "").toContain("text/html");
});

// --- Routing gates: reserved paths win; noise 404s without upstream calls -----

test("trailing-slash forms 301 to the canonical non-slash URLs (query preserved, zero fetches)", async () => {
	globalThis.fetch = repliesMock();
	const profile = await app.request(`/${USERNAME}/`);
	expect(profile.status).toBe(301);
	expect(profile.headers.get("location")).toBe(`/${USERNAME}`);

	const casts = await app.request(`/${USERNAME}/casts-and-replies/`);
	expect(casts.status).toBe(301);
	expect(casts.headers.get("location")).toBe(`/${USERNAME}/casts-and-replies`);

	// The query string rides the redirect (?format=json survives).
	const negotiated = await app.request(`/${USERNAME}/?format=json`);
	expect(negotiated.headers.get("location")).toBe(`/${USERNAME}?format=json`);

	// Gate still applies on the slash forms.
	const gated = await app.request(`/${"a".repeat(21)}/`);
	expect(gated.status).toBe(404);

	// Purely syntactic: zero upstream fetches anywhere in this test.
	const fetchMock = globalThis.fetch as ReturnType<typeof mock>;
	expect(fetchMock.mock.calls.length).toBe(0);
});

test("bot paths and non-username shapes 404 with ZERO upstream fetches", async () => {
	let calls = 0;
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		calls++;
		throw new Error(`Unexpected fetch in test: ${String(input)}`);
	}) as typeof fetch;

	for (const path of [
		"/favicon.ico",
		"/robots.txt",
		"/sitemap.xml",
		"/apple-touch-icon.png",
		"/manifest.json",
		`/${"a".repeat(21)}`, // over fname length
		`/${encodeURIComponent("a b")}`, // space outside the charset
	]) {
		const res = await app.request(path);
		expect(res.status).toBe(404);
	}
	expect(calls).toBe(0);
});

test("uppercase usernames lowercase before lookup", async () => {
	const res = await app.request("/Decent-Artlu");
	expect(res.status).toBe(200);
	expect(await res.text()).toContain("Bass Ackwards.");
});

test("reserved exact routes still win by registration order", async () => {
	// /transparency (registered before the parametric profile route) keeps
	// serving its page — a fetch-less read (no LMDIS env ⇒ null snapshots).
	const transparency = await app.request("/transparency");
	expect(transparency.status).toBe(200);
	expect(await transparency.text()).toContain("transparency");

	// /race-stats.json likewise; no snapshot in tests ⇒ 404, not a profile.
	const raceStats = await app.request("/race-stats.json");
	expect(raceStats.status).toBe(404);

	// /mcp keeps its browser-facing server card.
	const mcp = await app.request("/mcp");
	expect(mcp.status).toBe(200);
	expect(await mcp.text()).toContain("get_cast_link");
});

test("GET /api/ lists the profile JSON surface", async () => {
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

// --- /{username}/casts-and-replies: skeleton-only list surface ----------------

const REPLIES = {
	success: true,
	casts: [
		{
			fid: FID,
			hash: CAST_HASH,
			text: "first cast",
			timestamp: CAST_TS,
			embeds: [],
		},
		{
			fid: FID,
			hash: REPLY_HASH,
			text: "second cast",
			timestamp: CAST_TS,
			// Quote embed with no /h mock ⇒ hydration fails, quote dropped.
			embeds: [{ castId: { fid: 3854, hash: "0x11111111deadbeef" } }],
			parentCastId: { fid: FID, hash: REPLY_HASH },
		},
		// No hash ⇒ unroutable — must be skipped, not rendered as a dead card.
		{ fid: FID, text: "hashless", timestamp: CAST_TS, embeds: [] },
		{
			fid: FID,
			hash: "0xcccccccccccccccccccccccccccccccccccccccc",
			text: "linking example.com today",
			timestamp: CAST_TS,
			// URL embed with no unfurl mock ⇒ hostname fallback card.
			embeds: [{ url: "https://example.com/article" }],
		},
	],
};

function repliesMock(): typeof fetch {
	return shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: { success: true, user: USER },
		[`https://shim.artlu.xyz/signed/${FID}`]: {
			success: true,
			signed: true,
		},
		[`https://shim.artlu.xyz/${USERNAME}/casts-and-replies?limit=10`]: REPLIES,
	});
}

test("casts-and-replies renders full embed cards with the profile's OG preview", async () => {
	globalThis.fetch = repliesMock();
	const res = await app.request(`/${USERNAME}/casts-and-replies`);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type") ?? "").toContain("text/html");

	const body = await res.text();
	// Key-form title; head keeps the internal Profile link.
	expect(body).toContain(
		"<title>decent-artlu/casts-and-replies · forkcaster</title>",
	);
	expect(body).toContain(`href="/${USERNAME}">Profile</a>`);
	// The feed row: stateful pills — farcaster, Quorum, Quilcast,
	// Firefly, the four verified feed targets (pointer-scoped classes:
	// Quorum coarse-only, Quilcast fine-only).
	expect(body).toContain('data-client="farcaster" data-kind="feed"');
	expect(body).toContain('class="pill client-pill coarse-only" href="https://www.quorummessenger.com/" data-client="quorum" data-kind="feed"');
	expect(body).toContain(`class="pill client-pill fine-only" href="https://quilcast.com/u/${USERNAME}" data-client="quilcast" data-kind="feed"`);
	expect(body).toContain(`class="pill client-pill" href="https://firefly.social/profile/farcaster/${USERNAME}" data-client="firefly" data-kind="feed"`);
	// The OG preview is IDENTICAL to the profile's (entity-backed card);
	// canonical stays on this page's own URL.
	expect(body).toContain(
		'<meta property="og:title" content="Ultra (@decent-artlu)" />',
	);
	expect(body).toContain(
		`<meta property="og:image" content="${USER.pfpUrl}" />`,
	);
	// Full embed cards — the individual cast page's rendering, author
	// attached from the hydrated entity. Hashless rows are skipped.
	expect(body).toContain("farcaster-embed");
	expect(body).toContain(
		'<p class="farcaster-embed-author-display-name">Ultra</p>',
	);
	expect(body).toContain("first cast");
	expect(body).toContain("second cast");
	expect(body).toContain("farcaster-embed-farcaster-link");
	expect(body).not.toContain("hashless");
	// Per-card live-stats slot + the multi-slot fill script.
	expect(body).toContain(`data-hash="${CAST_HASH}"`);
	expect(body).toContain(`data-hash="${REPLY_HASH}"`);
	expect(body).toContain("farcaster.tv/");
	// The unfurl pipeline ran (no unfurl mock ⇒ hostname fallback card).
	expect(body).toContain("example.com");
	// The unhydrated quote (no /h mock) is dropped, not rendered broken.
	expect(body).not.toContain("quote-embeds");
	// No identity card, no advertised twin. The feed row is stateful now:
	// pills + telemetry ship; no cookie ⇒ no banner.
	expect(body).not.toContain('class="profile-card"');
	expect(body).toContain("data-client");
	expect(body).toContain("window.__fk");
	expect(body).not.toContain("data-auto");
	expect(body).not.toContain('rel="alternate"');
});

test("casts-and-replies canonicalizes under PRIMARY_ORIGIN", async () => {
	globalThis.fetch = repliesMock();
	const res = await app.request(`/${USERNAME}/casts-and-replies`, undefined, {
		PRIMARY_ORIGIN: "https://forkcaster.xyz",
	});
	expect(await res.text()).toContain(
		`<link rel="canonical" href="https://forkcaster.xyz/${USERNAME}/casts-and-replies" />`,
	);
});

test("casts-and-replies: /f miss ⇒ 404; /f unreachable ⇒ 503 + Retry-After", async () => {
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true },
	});
	const miss = await app.request(`/${USERNAME}/casts-and-replies`);
	expect(miss.status).toBe(404);
	expect(await miss.text()).toContain("Profile not found");

	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: new Error("shim unavailable"),
	});
	const down = await app.request(`/${USERNAME}/casts-and-replies`);
	expect(down.status).toBe(503);
	expect(down.headers.get("retry-after")).toBe("60");
	expect(await down.text()).toContain("temporarily unavailable");
});

test("casts-and-replies timeline fails soft; ok-empty is honest", async () => {
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/${USERNAME}/casts-and-replies?limit=10`]: {
			success: false,
			error: "getHubFidByUsername: User not found",
		},
	});
	const failed = await app.request(`/${USERNAME}/casts-and-replies`);
	expect(failed.status).toBe(200);
	expect(await failed.text()).toContain(
		"Recent casts are unavailable right now.",
	);

	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/${USERNAME}/casts-and-replies?limit=10`]: {
			success: true,
			casts: [],
		},
	});
	const empty = await app.request(`/${USERNAME}/casts-and-replies`);
	expect(empty.status).toBe(200);
	expect(await empty.text()).toContain("No casts yet.");
});

test("casts-and-replies: the unsigned feed menu drops Farcaster", async () => {
	// Signed suppression extends to kind targets (fail-open): unsigned ⇒
	// the farcaster feed pill is suppressed. The other feed targets
	// (quorum, quilcast, firefly) carry no signed rule and stay — the notice
	// explains the farcaster gap. The cards' cast-scoped farcaster.xyz
	// anchors retarget to the local waypoint (dead links for an unsigned
	// author — pinned in the dedicated test below); the profile anchor
	// stays.
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: { success: true, user: USER },
		[`https://shim.artlu.xyz/signed/${FID}`]: {
			success: true,
			signed: false,
		},
		[`https://shim.artlu.xyz/${USERNAME}/casts-and-replies?limit=10`]: REPLIES,
	});
	const res = await app.request(`/${USERNAME}/casts-and-replies`);
	expect(res.status).toBe(200);

	const body = await res.text();
	// The exact head link is gone (the card links continue with /0x…, so
	// the trailing-quote substring only matches the head).
	expect(body).not.toContain('href="https://farcaster.xyz/decent-artlu">');
	expect(body).not.toContain(">Open on Farcaster</a>");
	expect(body).not.toContain('data-client="farcaster"');
	expect(body).toContain("read-only on farcaster.xyz");
	// The cards themselves are unaffected.
	expect(body).toContain("first cast");
});

test("unsigned casts page: dead farcaster.xyz cast anchors retarget to the forkcaster waypoint", async () => {
	// signed:false ⇒ farcaster.xyz is read-only for the author, so the
	// cast URL the embed stamps on every card (Show-on-Farcaster icon)
	// and the client-built stats links point at a dead page there. The
	// cards retarget those — and only those — to the local waypoint;
	// the profile anchor stays (it works unsigned) and author-typed
	// farcaster.xyz links in cast text are content, untouched.
	const withFarcasterBodyLink = {
		success: true,
		casts: [
			{
				fid: FID,
				hash: CAST_HASH,
				text: `see https://farcaster.xyz/${USERNAME}/${CAST_HASH} too`,
				timestamp: CAST_TS,
				embeds: [],
			},
		],
	};
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: { success: true, user: USER },
		[`https://shim.artlu.xyz/signed/${FID}`]: {
			success: true,
			signed: false,
		},
		[`https://shim.artlu.xyz/${USERNAME}/casts-and-replies?limit=10`]:
			withFarcasterBodyLink,
	});
	const res = await app.request(`/${USERNAME}/casts-and-replies`);
	expect(res.status).toBe(200);

	const body = await res.text();
	// The icon anchor is retargeted and relabeled (hardenBlankTargets ran
	// first, hence the rel).
	expect(body).toContain(
		`<a href="/${USERNAME}/${CAST_HASH}" title="Open on forkcaster" target="_blank" rel="noopener" class="farcaster-embed-farcaster-link">`,
	);
	// The stats slot is flagged; the fill script writes local links there.
	expect(body).toContain('data-local="1"');
	// Author content immunity: the typed URL keeps its farcaster.xyz href
	// (class-scoped rewrite — body links are never touched).
	expect(body).toContain(
		`<a href="https://farcaster.xyz/${USERNAME}/${CAST_HASH}" target="_blank" rel="noopener" class="farcaster-embed-body-link">`,
	);

	// The signed page keeps every original farcaster.xyz anchor (fail
	// open: only a PROVEN-unsigned author gets the retarget). The bare
	// "data-local" string ships inside LIVE_STATS_SCRIPT itself, so the
	// attribute form is the discriminator.
	globalThis.fetch = repliesMock();
	const signedBody = await (
		await app.request(`/${USERNAME}/casts-and-replies`)
	).text();
	expect(signedBody).toContain(
		`<a href="https://farcaster.xyz/${USERNAME}/${CAST_HASH}" title="Show on Farcaster" target="_blank" rel="noopener" class="farcaster-embed-farcaster-link">`,
	);
	expect(signedBody).not.toContain('data-local="1"');
});

test("profile card escapes hostile upstream text (XSS regression)", async () => {
	// displayName/bio/pfp are untrusted upstream text — same escaper as the
	// cast pages, but pinned here because og attributes + the identity card
	// are new interpolation sites. Note: displayName never reaches <title>
	// (the key-form title carries the handle, not the entity).
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: {
			success: true,
			user: {
				fid: FID,
				username: USERNAME,
				displayName: `</title><script>alert(1)</script> & "quotes"`,
				bio: `<b>bold</b> & 'single' "double"`,
				pfpUrl: `https://img.test/x" onerror="alert(1)`,
			},
		},
		[`https://shim.artlu.xyz/${USERNAME}/casts-and-replies?limit=10`]: CASTS,
	});
	const res = await app.request(`/${USERNAME}`);
	expect(res.status).toBe(200);

	const body = await res.text();
	// Nothing raw survives: the XSS vectors are gone, and `alert(1)` may only
	// appear inside escaped attribute values (entities can't break out).
	expect(body).not.toContain("<script>alert(1)");
	expect(body).not.toContain('" onerror=');
	expect(body).not.toContain("<b>bold</b>");
	// h1 + og:title render the escaped form…
	expect(body).toContain(
		'<h1 class="profile-title">&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;</h1>',
	);
	expect(body).toContain('content="&lt;/title&gt;&lt;script&gt;');
	// …as does the bio paragraph.
	expect(body).toContain(
		"<p class=\"profile-bio\">&lt;b&gt;bold&lt;/b&gt; &amp; &#39;single&#39; &quot;double&quot;</p>",
	);
	// And the hostile pfp stays an inert, escaped attribute value.
	expect(body).toContain('src="https://img.test/x&quot; onerror=&quot;alert(1)"');
});

test("signed-check unavailable fails open: Farcaster stays offered", async () => {
	// No /signed mock — the check throws internally, null ⇒ fail open.
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: { success: true, user: USER },
	});
	const res = await app.request(`/${USERNAME}`);
	expect(res.status).toBe(200);

	const body = await res.text();
	// Fail-open menu: farcaster offered alongside the capable unsigned
	// clients, no notice.
	expect(body).toContain('data-client="farcaster" data-kind="profile"');
	expect(body).toContain('data-client="quilcast" data-kind="profile"');
	expect(body).toContain('data-client="quorum" data-kind="profile"');
	expect(body).toContain('data-client="firefly" data-kind="profile"');
	expect(body).not.toContain("read-only on farcaster.xyz");
});

test("unsigned profile swaps the Farcaster way out for Quorum + Quilcast", async () => {
	// decent-artlu's real state: fid 3319217 has NOT signed the social
	// smart contract — farcaster.xyz is read-only for them, so "Open on
	// Farcaster" would be futile.
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: { success: true, user: USER },
		[`https://shim.artlu.xyz/signed/${FID}`]: {
			success: true,
			signed: false,
		},
	});
	const res = await app.request(`/${USERNAME}`);
	expect(res.status).toBe(200);

	const body = await res.text();
	// Farcaster is not offered at all (requiresSigned extends to kind
	// targets; every other signed state fails open and offers it).
	expect(body).not.toContain('data-client="farcaster"');
	expect(body).not.toContain('href="https://farcaster.xyz/decent-artlu"');
	// The menu IS the way out now: stateful pills, registry-ordered (no
	// rank snapshot reaches the test env), logos and pointer scopes from
	// the targets, native attempts through the row's DEEPLINK_SCRIPT.
	// Registry order: quorum first, firefly second, quilcast third.
	expect(body).toContain(
		'class="pill client-pill coarse-only" href="https://www.quorummessenger.com/" data-client="quorum" data-kind="profile" data-intent="intent://feed?profileFid=3319217&amp;profileUsername=decent-artlu#Intent;scheme=quorummobile;package=com.quilibrium.quorummobile;S.browser_fallback_url=https%3A%2F%2Fwww.quorummessenger.com%2F;end" data-scheme="quorummobile://feed?profileFid=3319217&amp;profileUsername=decent-artlu">',
	);
	expect(body).toContain("/logos/quorum.png");
	expect(body).toContain(">Quorum</a>");
	expect(body).toContain(
		`class="pill client-pill" href="https://firefly.social/profile/farcaster/${USERNAME}" data-client="firefly" data-kind="profile"`,
	);
	expect(body).toContain(">Firefly</a>");
	expect(body).toContain(
		`class="pill client-pill fine-only" href="https://quilcast.com/u/${USERNAME}" data-client="quilcast" data-kind="profile"`,
	);
	expect(body).toContain(">Quilcast</a>");
	// DEEPLINK_SCRIPT ships with the row; telemetry scripts too.
	expect(body).toContain("(pointer: coarse)");
	expect(body).toContain("window.__fk");
	expect(body).toContain("read-only on farcaster.xyz");
	// The identity card is otherwise unchanged.
	expect(body).toContain("Bass Ackwards.");
	expect(body).toContain(`href="/${USERNAME}/casts-and-replies">Casts and replies</a>`);

	// The JSON twin carries the same note the cast JSON uses.
	const json = await app.request(`/${USERNAME}?format=json`);
	const data = await json.json();
	expect(data.note).toContain("social smart contract");
});

test("casts-and-replies lowercases the username before lookup", async () => {
	globalThis.fetch = repliesMock();
	const res = await app.request("/Decent-Artlu/casts-and-replies");
	expect(res.status).toBe(200);
	expect(await res.text()).toContain("first cast");
});

// --- /~/conversations/0x…: canonicalizing redirect (Warpcast legacy shape) ----

const ALIAS_HASH = "0x3ceab47a5990cce65e0116e32dec0aacfdf4aed1";
const ALIAS_CAST = {
	fid: FID,
	hash: ALIAS_HASH,
	text: "the aliased cast",
	timestamp: CAST_TS,
	embeds: [],
	user: { fid: FID, username: USERNAME },
};

test("/~/conversations/{hash} 302s to the canonical cast waypoint", async () => {
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/h/${ALIAS_HASH}`]: {
			success: true,
			cast: ALIAS_CAST,
		},
	});
	const res = await app.request(`/~/conversations/${ALIAS_HASH}`);
	expect(res.status).toBe(302);
	// Relative Location: dual-serve hosts stay self-contained. The target is
	// the FULL resolved hash (the form the cast route canonicalizes to).
	expect(res.headers.get("location")).toBe(`/${USERNAME}/${ALIAS_HASH}`);
});

test("username-less cast falls back to shim /u/{fid}", async () => {
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/h/${ALIAS_HASH}`]: {
			success: true,
			cast: { ...ALIAS_CAST, user: undefined },
		},
		"https://shim.artlu.xyz/u/3319217": { success: true, username: USERNAME },
	});
	const res = await app.request(`/~/conversations/${ALIAS_HASH}`);
	expect(res.status).toBe(302);
	expect(res.headers.get("location")).toBe(`/${USERNAME}/${ALIAS_HASH}`);
});

test("alias: shim miss ⇒ 404; username-less with /u miss ⇒ 404; shim down ⇒ 503", async () => {
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/h/${ALIAS_HASH}`]: {
			success: false,
			error: "getCastByHash: Cast not found",
		},
	});
	const miss = await app.request(`/~/conversations/${ALIAS_HASH}`);
	expect(miss.status).toBe(404);

	// Cast found but /u authoritatively has no username — a real dead end.
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/h/${ALIAS_HASH}`]: {
			success: true,
			cast: { ...ALIAS_CAST, user: undefined },
		},
		"https://shim.artlu.xyz/u/3319217": { success: true },
	});
	const noName = await app.request(`/~/conversations/${ALIAS_HASH}`);
	expect(noName.status).toBe(404);

	// Shim down ⇒ 503 + Retry-After — there is nothing to fail open to.
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/h/${ALIAS_HASH}`]: new Error("shim unavailable"),
	});
	const down = await app.request(`/~/conversations/${ALIAS_HASH}`);
	expect(down.status).toBe(503);
	expect(down.headers.get("retry-after")).toBe("60");
});

test("alias: non-0x shapes never match the route (no upstream calls)", async () => {
	let calls = 0;
	globalThis.fetch = mock(async () => {
		calls++;
		throw new Error("Unexpected fetch in test");
	}) as typeof fetch;
	expect((await app.request("/~/conversations/nothex")).status).toBe(404);
	expect(calls).toBe(0);
});

// --- Phase 2: the stateful layer (badge + auto-open on the user routes) -------

const signedTrueMock = () =>
	shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: { success: true, user: USER },
		[`https://shim.artlu.xyz/signed/${FID}`]: { success: true, signed: true },
	});

test("profile menu: the badge marks the resolved client (kind slug outranks cast slug)", async () => {
	globalThis.fetch = signedTrueMock();
	const res = await app.request(`/${USERNAME}`, {
		headers: { Cookie: "fc_client=farcaster|p:quilcast" },
	});
	const body = await res.text();
	// Resolution = the kind's own slug; the row publishes it for the
	// client script's first/switch/repeat and the badge.
	expect(body).toContain('data-resolved="quilcast"');
	const quilcast = body.indexOf('data-client="quilcast"');
	const farcaster = body.indexOf('data-client="farcaster"');
	expect(body.slice(quilcast, quilcast + 400)).toContain("pill-badge");
	expect(body.slice(farcaster, farcaster + 400)).not.toContain("pill-badge");
});

test("profile auto-open: flat cast inheritance arms the overlay", async () => {
	globalThis.fetch = signedTrueMock();
	const res = await app.request(`/${USERNAME}`, {
		headers: { Cookie: "fc_client=farcaster|auto-on" },
	});
	const body = await res.text();
	expect(body).toContain('data-auto="on"');
	expect(body).toContain('data-auto-noun="profiles"');
	expect(body).toContain('data-auto-kind="profile"');
	expect(body).toContain(`data-auto-url="https://farcaster.xyz/${USERNAME}"`);
	expect(body).toContain('data-auto-slug="farcaster"');
});

test("profile auto-open: an incapable cast slug resolves nothing to open — the idle chip names why, badgeless menu", async () => {
	globalThis.fetch = signedTrueMock();
	const res = await app.request(`/${USERNAME}`, {
		headers: { Cookie: "fc_client=linkcast|auto-on" },
	});
	const body = await res.text();
	// linkcast has no profile target: flat inheritance finds nothing ⇒ no
	// redirect fires — and the non-redirect is EXPLAINED (the idle
	// chip): the armed client is named, the menu below is the way out.
	// No redirect targets, no arming overlay, and the menu renders
	// without a badge. (The attribute form: the bare string also appears
	// inside CLIENT_SCRIPT.)
	expect(body).not.toContain("data-auto-url");
	expect(body).not.toContain('data-resolved="');
	expect(body).not.toContain('data-auto="on"');
	expect(body).toContain('data-auto="idle"');
	expect(body).toContain(
		"Auto-open: Linkcast isn&#39;t offered here — pick below",
	);
	expect(body).toContain('data-client="farcaster" data-kind="profile"');
});

test("profile auto-open: ?noredirect=1 renders the chip, never the overlay", async () => {
	globalThis.fetch = signedTrueMock();
	const res = await app.request(`/${USERNAME}?noredirect=1`, {
		headers: { Cookie: "fc_client=farcaster|auto-on" },
	});
	const body = await res.text();
	expect(body).toContain('data-auto="noredirect"');
	expect(body).not.toContain('data-auto="on"');
});

test("unsigned profile: capable kind slugs still auto-open", async () => {
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: { success: true, user: USER },
		[`https://shim.artlu.xyz/signed/${FID}`]: { success: true, signed: false },
	});
	const res = await app.request(`/${USERNAME}`, {
		headers: { Cookie: "fc_client=linkcast|p:quilcast|auto-on" },
	});
	const body = await res.text();
	// quilcast's profile target is unsigned-friendly; the incapable cast
	// slug (linkcast) never fires — flat, own kind first.
	expect(body).toContain(`data-auto-url="https://quilcast.com/u/${USERNAME}"`);
	expect(body).toContain('data-auto-slug="quilcast"');
});
