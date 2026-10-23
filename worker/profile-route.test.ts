/**
 * Profile route integration tests (PLAN4).
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
	bio: "Bass Ackwards.",
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
	// Skeleton rows route into the cast waypoints, with markers.
	expect(body).toContain(`href="/${USERNAME}/${CAST_HASH}"`);
	expect(body).toContain(`href="/${USERNAME}/${REPLY_HASH}"`);
	expect(body).toContain("↳ reply");
	expect(body).toContain("[image]");
	expect(body).toContain("Recent casts");
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
	// Waypoint law: zero telemetry/personalization surface. The copy helper
	// is the page's ONLY script — no pills, no auto-open, no beacons.
	expect(body).toContain("data-copy");
	expect(body).not.toContain("window.__fk");
	expect(body).not.toContain("data-client");
	expect(body).not.toContain("data-auto");
	expect(body).not.toContain("fc_client=");
	expect(body).not.toContain("farcaster.tv");
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
	// ok+empty timeline is a real "No casts yet." — not an outage note.
	expect(body).toContain("No casts yet.");
	expect(body).not.toContain("unavailable right now");
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

test("timeline success:false ⇒ 200 with an unavailable note (HTML + JSON note)", async () => {
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: { success: true, user: USER },
		[`https://shim.artlu.xyz/${USERNAME}/casts-and-replies?limit=10`]: {
			success: false,
			error: "getHubFidByUsername: User not found",
		},
	});
	const res = await app.request(`/${USERNAME}`);
	expect(res.status).toBe(200);
	const body = await res.text();
	expect(body).toContain("Recent casts are unavailable right now.");
	// The identity card still renders in full.
	expect(body).toContain("Bass Ackwards.");

	const json = await app.request(`/${USERNAME}?format=json`);
	const data = await json.json();
	expect(data.note).toBe("timeline unavailable");
	expect("casts" in data).toBe(false);
});

test("timeline network failure ⇒ same fail-soft note", async () => {
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: { success: true, user: USER },
		[`https://shim.artlu.xyz/${USERNAME}/casts-and-replies?limit=10`]:
			new Error("shim timeline down"),
	});
	const res = await app.request(`/${USERNAME}`);
	expect(res.status).toBe(200);
	expect(await res.text()).toContain("Recent casts are unavailable right now.");
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
	expect(body.bio).toBe("Bass Ackwards.");
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
			embeds: [],
			parentCastId: { fid: FID, hash: REPLY_HASH },
		},
		// No hash ⇒ unroutable — must be skipped, not rendered as a dead row.
		{ fid: FID, text: "hashless", timestamp: CAST_TS, embeds: [] },
	],
};

function repliesMock(): typeof fetch {
	return shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/${USERNAME}/casts-and-replies?limit=3`]: REPLIES,
	});
}

test("casts-and-replies renders the fixed-3 skeleton with no identity card", async () => {
	globalThis.fetch = repliesMock();
	const res = await app.request(`/${USERNAME}/casts-and-replies`);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type") ?? "").toContain("text/html");

	const body = await res.text();
	// Key-form title; minimal handle head with the way out (profile + Farcaster).
	expect(body).toContain(
		"<title>decent-artlu/casts-and-replies · forkcaster</title>",
	);
	expect(body).toContain("<h1 class=\"profile-title\">@decent-artlu</h1>");
	expect(body).toContain(`href="/${USERNAME}">Profile</a>`);
	expect(body).toContain(
		`href="https://farcaster.xyz/${USERNAME}">Open on Farcaster</a>`,
	);
	// Skeleton rows only: the routable ones render, the hashless one doesn't.
	expect(body).toContain("first cast");
	expect(body).toContain(`href="/${USERNAME}/${REPLY_HASH}"`);
	expect(body).toContain("↳ reply");
	expect(body).not.toContain("hashless");
	// No identity card (match the element, not the CSS class in <style>),
	// no scripts at all, no advertised JSON twin.
	expect(body).not.toContain('class="profile-card"');
	expect(body).not.toContain("Bass Ackwards");
	expect(body).not.toContain("<script");
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
		[`https://shim.artlu.xyz/${USERNAME}/casts-and-replies?limit=3`]: {
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
		[`https://shim.artlu.xyz/${USERNAME}/casts-and-replies?limit=3`]: {
			success: true,
			casts: [],
		},
	});
	const empty = await app.request(`/${USERNAME}/casts-and-replies`);
	expect(empty.status).toBe(200);
	expect(await empty.text()).toContain("No casts yet.");
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
