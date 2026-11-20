/**
 * Profile route integration tests.
 *
 * Same contract as cast-route.test.ts: `app.request(...)`, globalThis.fetch
 * mocked and routed by exact shim URL — unexpected URLs throw, which is how
 * the zero-fetch gates (denylist, charset) are asserted. The profile surface
 * resolves entirely through shim: /f/{username} (identity verdict),
 * /user/{fid} (hydrated entity), /signed/{fid} (ban signal). Identity-only
 * — no timeline on HTML or JSON.
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
	});
}

beforeEach(() => {
	globalThis.fetch = defaultMock();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

// --- HTML: the identity card is the whole hydrated entity --------------------

// Server markup vs script source: the auto-open box is built client-side
// (SHELL_SCRIPT), so the script TEXT contains data-auto fragments that
// would false-positive naive body assertions. Strip scripts, assert markup.
function withoutScripts(html: string): string {
	return html.replace(/<script>[\s\S]*?<\/script>/g, "");
}

test("profile page renders the full hydrated entity as the identity card", async () => {
	const res = await app.request(`/${USERNAME}`);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type") ?? "").toContain("text/html");

	const body = await res.text();
	// Card: displayName title, handle, avatar, bio, fid.
	// Minimal key-form <title> (cast-page convention); the rich form rides
	// on og:title.
	expect(body).toContain("<title>decent-artlu · forkcaster</title>");
	// Card handle line: bold primary (identity law — legacy entity ⇒ the
	// newest-proof username IS the primary), no attestation parens.
	expect(body).toContain(
		"<p class=\"profile-handle\">@<strong>decent-artlu</strong></p>",
	);
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
	// feed waypoint lives on /{username}/casts-and-replies, one pill away.
	expect(body).toContain(
		`href="/${USERNAME}/casts-and-replies">Casts and replies</a>`,
	);
	expect(body).not.toContain("Recent casts");
	expect(body).not.toContain('class="profile-cast"');
	expect(body).not.toContain('class="farcaster-embed');
	// Identity-only: /f + /user (+ /signed), never the timeline.
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
	// ships the menu + scripts; still no auto-open MARKUP for a
	// cookieless visitor (SHELL_SCRIPT renders it client-side), no feed
	// reading, no engagement surface.
	expect(body).toContain("data-copy");
	expect(body).toContain("window.__fk");
	expect(body).toContain('data-client="farcaster" data-kind="profile"');
	expect(withoutScripts(body)).not.toContain("data-auto");
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

test("display waterfall: no displayName falls to the username before the fname", async () => {
	// nikolaiii's shape: fname ≠ username, no displayName. The h1/og:title
	// fallback (displayFallback) carries the USERNAME — the name they go
	// by — while the handle LINE below keeps the identity-law primary.
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: {
			success: true,
			user: {
				fid: FID,
				username: "nikolaii.eth",
				fname: USERNAME,
				displayName: null,
				bio: null,
			},
		},
	});
	const res = await app.request(`/${USERNAME}`);
	expect(res.status).toBe(200);

	const body = await res.text();
	expect(body).toContain('<h1 class="profile-title">@nikolaii.eth</h1>');
	expect(body).toContain('<meta property="og:title" content="@nikolaii.eth" />');
	// The handle line keeps the fname primary (the identity law's route
	// handle — attestations render beside it).
	expect(body).toContain("@<strong>decent-artlu</strong>");
});

test("a malformed primaryAddress renders as bare text — no copy, no explorer", async () => {
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: {
			success: true,
			user: { ...USER, primaryAddress: "not-an-address" },
		},
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

test("JSON twin never fetches the timeline", async () => {
	const fetchMock = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: { success: true, user: USER },
		[`https://shim.artlu.xyz/signed/${FID}`]: {
			success: true,
			signed: true,
		},
	});
	globalThis.fetch = fetchMock;
	const json = await app.request(`/${USERNAME}?format=json`);
	expect(json.status).toBe(200);
	const data = await json.json();
	expect("casts" in data).toBe(false);
	expect("note" in data).toBe(false);
	expect(
		fetchMock.mock.calls.every((c) =>
			!String(c[0]).includes("casts-and-replies"),
		),
	).toBe(true);
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
	expect(body.farcaster).toBe(`https://farcaster.xyz/${USERNAME}`);
	// Identity-only: no casts. proNft: typed, never emitted.
	expect("casts" in body).toBe(false);
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
	globalThis.fetch = feedWaypointMock();
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

test("first-party links echo the validated input; display keeps the entity handle", async () => {
	// The seam: shim /user/{fid} answers the CANONICAL username — the newest
	// username proof, which can be an ENS (arfonzo.eth) while the visitor
	// arrived by the fname (arfonzo). This fixture is a LEGACY entity (no
	// fname/attestations — old shim or stale cache): it pins both that
	// first-party links echo the input and that the pre-identity-law
	// rendering is unchanged (the newest-proof username carries display,
	// OG, canonical, and the JSON twin).
	const ALIAS = "arfonzo";
	const ENTITY = "arfonzo.eth";
	// The alias resolves to the fid; the entity answers the canonical
	// handle. `signed` is the knob — both variants are pinned below.
	const aliasMock = (signed: boolean): typeof fetch =>
		shimMock({
			[`https://shim.artlu.xyz/f/${ALIAS}`]: { success: true, fid: FID },
			[`https://shim.artlu.xyz/user/${FID}`]: {
				success: true,
				user: { ...USER, username: ENTITY },
			},
			[`https://shim.artlu.xyz/signed/${FID}`]: { success: true, signed },
		});
	globalThis.fetch = aliasMock(true);

	const profile = await app.request(`/${ALIAS}`);
	const profileBody = await profile.text();
	// The pill echoes the input…
	expect(profileBody).toContain(
		`href="/${ALIAS}/casts-and-replies">Casts and replies</a>`,
	);
	// …while the card and og:title keep the canonical entity handle.
	expect(profileBody).toContain(`@${ENTITY}`);
	expect(profileBody).toContain(
		`<meta property="og:title" content="Ultra (@${ENTITY})" />`,
	);

	const casts = await app.request(`/${ALIAS}/casts-and-replies`);
	const castsBody = await casts.text();
	// The head's Profile link echoes the input back…
	expect(castsBody).toContain(`href="/${ALIAS}">Profile</a>`);
	// …and the feed waypoint title stays the entity display name.
	expect(castsBody).toContain('<h1 class="profile-title">Ultra</h1>');
	expect(castsBody).not.toContain('class="farcaster-embed');

	// Gate normalization rides along: typed capitals echo lowercase.
	const caps = await app.request("/Arfonzo");
	expect(await caps.text()).toContain(
		`href="/arfonzo/casts-and-replies">Casts and replies</a>`,
	);

	// The agent twin stays canonical — machines get the entity username.
	const json = await app.request(`/${ALIAS}?format=json`);
	expect((await json.json()).username).toBe(ENTITY);

	// The unsigned feed waypoint: Farcaster is dropped; the Profile
	// back-link still echoes the typed alias (first-party).
	globalThis.fetch = aliasMock(false);
	const unsigned = await app.request(`/${ALIAS}/casts-and-replies`);
	const unsignedBody = await unsigned.text();
	expect(unsignedBody).toContain(`href="/${ALIAS}">Profile</a>`);
	expect(unsignedBody).not.toContain('data-client="farcaster"');
	expect(unsignedBody).toContain("read-only on farcaster.xyz");
});

test("identity law: the fname is the primary handle; ENS names are attestations", async () => {
	// Identity law: the fname — the account's
	// FIRST name — is primary; any number of ENS names (L1 + L2) are
	// attestations, rendered in parens after it. The shim entity carries
	// the split alongside the newest-proof username. Arriving by the ENS
	// must still present the fname as the identity, canonicalize to the
	// fname URL, and echo the typed alias in first-party links.
	const attestations = ["arfonzo.eth", "artlu.base.eth", "spare.eth", "extra.eth"];
	globalThis.fetch = shimMock({
		"https://shim.artlu.xyz/f/arfonzo.eth": { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: {
			success: true,
			// displayName overridden so the fixture can't be misread as a
			// real account — this is the shape, not anyone's profile.
			user: {
				...USER,
				displayName: "Arfonzo",
				username: "arfonzo.eth",
				fname: "arfonzo",
				attestations,
			},
		},
		[`https://shim.artlu.xyz/signed/${FID}`]: { success: true, signed: true },
	});

	const res = await app.request("/arfonzo.eth", undefined, {
		PRIMARY_ORIGIN: "https://forkcaster.xyz",
	});
	const body = await res.text();
	// The card: bold primary, attestations in parens — capped at 3…
	expect(body).toContain(
		"<p class=\"profile-handle\">@<strong>arfonzo</strong> (arfonzo.eth, artlu.base.eth, spare.eth)</p>",
	);
	// …og:title and canonical carry the primary…
	expect(body).toContain(
		'<meta property="og:title" content="Arfonzo (@arfonzo)" />',
	);
	expect(body).toContain(
		'<link rel="canonical" href="https://forkcaster.xyz/arfonzo" />',
	);
	// …while first-party links echo the typed alias.
	expect(body).toContain(
		`href="/arfonzo.eth/casts-and-replies">Casts and replies</a>`,
	);

	// The JSON twin: primary username, attestations uncapped (data, not
	// display).
	const json = await app.request("/arfonzo.eth?format=json");
	const twin = (await json.json()) as {
		username: string;
		attestations?: string[];
	};
	expect(twin.username).toBe("arfonzo");
	expect(twin.attestations).toEqual(attestations);
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

// --- /{username}/casts-and-replies: feed waypoint (no cast list) ------------

function feedWaypointMock(signed = true): typeof fetch {
	return shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: { success: true, user: USER },
		[`https://shim.artlu.xyz/signed/${FID}`]: {
			success: true,
			signed,
		},
	});
}

test("casts-and-replies is a feed waypoint: menu + OG, no cast list, no timeline fetch", async () => {
	globalThis.fetch = feedWaypointMock();
	const res = await app.request(`/${USERNAME}/casts-and-replies`);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type") ?? "").toContain("text/html");

	const body = await res.text();
	// Key-form title; head keeps the internal Profile link.
	expect(body).toContain(
		"<title>decent-artlu/casts-and-replies · forkcaster</title>",
	);
	expect(body).toContain(`href="/${USERNAME}">Profile</a>`);
	expect(body).toContain('<h1 class="profile-title">Ultra</h1>');
	// The feed row: stateful pills — farcaster, Quorum, Quilcast,
	// Firefly, the verified feed targets (pointer-scoped classes:
	// Quorum coarse-only, Quilcast fine-only).
	expect(body).toContain('data-client="farcaster" data-kind="feed"');
	expect(body).toContain('class="pill client-pill coarse-only" href="https://www.quorummessenger.com/" data-client="quorum" data-kind="feed"');
	expect(body).toContain(`class="pill client-pill fine-only" href="https://quilcast.com/u/${USERNAME}" data-client="quilcast" data-kind="feed"`);
	expect(body).toContain(`class="pill client-pill" href="https://firefly.social/profile/farcaster/${USERNAME}" data-client="firefly" data-kind="feed"`);
	expect(body).toContain(`class="pill client-pill" href="https://vibeshift.onchain.cooking/?view=profile&amp;profileFid=${FID}&amp;profileTab=casts" data-client="vibeshift" data-kind="feed"`);
	expect(body).toContain(`class="pill client-pill" href="https://linkcast.xyz/u/${USERNAME}" data-client="linkcast" data-kind="feed"`);
	// The OG preview is IDENTICAL to the profile's (entity-backed card);
	// canonical stays on this page's own URL.
	expect(body).toContain(
		'<meta property="og:title" content="Ultra (@decent-artlu)" />',
	);
	expect(body).toContain(
		`<meta property="og:image" content="${USER.pfpUrl}" />`,
	);
	// No cast list — no embed cards, no empty/unavailable copy.
	// (The shell still links /farcaster-embed.css; assert the card class.)
	expect(body).not.toContain('class="farcaster-embed');
	expect(body).not.toContain("casts-embeds");
	expect(body).not.toContain("No casts yet.");
	expect(body).not.toContain("Recent casts are unavailable");
	// No identity card, no advertised twin. The feed row is stateful:
	// pills + telemetry ship; no cookie ⇒ the script renders no box.
	expect(body).not.toContain('class="profile-card"');
	expect(body).toContain("data-client");
	expect(body).toContain("window.__fk");
	expect(withoutScripts(body)).not.toContain("data-auto");
	expect(body).not.toContain('rel="alternate"');
	// Skips the timeline fleet race entirely (only /f + /user + /signed).
	const fetchMock = globalThis.fetch as ReturnType<typeof mock>;
	expect(
		fetchMock.mock.calls.every((c) =>
			!String(c[0]).includes("casts-and-replies"),
		),
	).toBe(true);
});

test("casts-and-replies canonicalizes under PRIMARY_ORIGIN", async () => {
	globalThis.fetch = feedWaypointMock();
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

test("casts-and-replies: the unsigned feed menu drops Farcaster", async () => {
	// Signed suppression extends to kind targets (fail-open): unsigned ⇒
	// the farcaster feed pill is suppressed. The other feed targets
	// (quorum, quilcast, firefly, vibeshift) carry no signed rule and stay
	// — the notice explains the farcaster gap.
	globalThis.fetch = feedWaypointMock(false);
	const res = await app.request(`/${USERNAME}/casts-and-replies`);
	expect(res.status).toBe(200);

	const body = await res.text();
	expect(body).not.toContain('href="https://farcaster.xyz/decent-artlu">');
	expect(body).not.toContain(">Open on Farcaster</a>");
	expect(body).not.toContain('data-client="farcaster"');
	expect(body).toContain("read-only on farcaster.xyz");
	expect(body).toContain('data-client="quilcast" data-kind="feed"');
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
	expect(body).toContain('data-client="vibeshift" data-kind="profile"');
	expect(body).toContain('data-client="linkcast" data-kind="profile"');
	expect(body).toContain('data-client="opencaster" data-kind="profile"');
	expect(body).toContain('data-client="homiehouse" data-kind="profile"');
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
	// Registry order: quorum first, firefly second, quilcast third,
	// vibeshift fourth, linkcast fifth, opencaster sixth, homiehouse
	// seventh.
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
		`class="pill client-pill" href="https://vibeshift.onchain.cooking/?view=profile&amp;profileFid=${FID}&amp;profileTab=casts" data-client="vibeshift" data-kind="profile"`,
	);
	expect(body).toContain(
		`class="pill client-pill" href="https://linkcast.xyz/u/${USERNAME}" data-client="linkcast" data-kind="profile"`,
	);
	expect(body).toContain(
		`class="pill client-pill fine-only" href="https://quilcast.com/u/${USERNAME}" data-client="quilcast" data-kind="profile"`,
	);
	expect(body).toContain(">Quilcast</a>");
	expect(body).toContain(
		`class="pill client-pill" href="https://opencaster.org/profile/${USERNAME}" data-client="opencaster" data-kind="profile"`,
	);
	expect(body).toContain(
		`class="pill client-pill" href="https://homiehouse.app/profile?user=${USERNAME}" data-client="homiehouse" data-kind="profile"`,
	);
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
	globalThis.fetch = feedWaypointMock();
	const res = await app.request("/Decent-Artlu/casts-and-replies");
	expect(res.status).toBe(200);
	const body = await res.text();
	expect(body).toContain(`href="/decent-artlu">Profile</a>`);
	expect(body).toContain('data-kind="feed"');
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

test("alias redirect carries the primary handle (identity law)", async () => {
	// The newest proof is the ENS; the fname is primary. The 302 target
	// carries the fname, not the entity's newest-proof username.
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/h/${ALIAS_HASH}`]: {
			success: true,
			cast: {
				...ALIAS_CAST,
				user: { fid: FID, username: `${USERNAME}.eth`, fname: USERNAME },
			},
		},
	});
	const res = await app.request(`/~/conversations/${ALIAS_HASH}`);
	expect(res.status).toBe(302);
	expect(res.headers.get("location")).toBe(`/${USERNAME}/${ALIAS_HASH}`);
});

// shimMock can only answer JSON-at-200; the rescue also needs non-2xx
// shapes, so these tests wire their own URL-routed mocks.

test("alias: a cold shim index falls to the farcaster.tv rescue — 302 + shim warm", async () => {
	let warmed = 0;
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === `https://shim.artlu.xyz/h/${ALIAS_HASH}`) {
			// Shim's miss is HTTP 200 {"success":false} — a cold index,
			// NOT a verdict.
			return Response.json({ success: false, error: "Cast not found" });
		}
		if (url === `https://farcaster.tv/~/${ALIAS_HASH}`) {
			return Response.json({
				result: {
					casts: [{ hash: ALIAS_HASH, author: { fid: FID, username: USERNAME } }],
				},
			});
		}
		if (url === "https://shim.artlu.xyz/refresh") {
			warmed++;
			return Response.json({ success: true });
		}
		throw new Error(`Unexpected fetch in test: ${url}`);
	}) as typeof fetch;
	const res = await app.request(`/~/conversations/${ALIAS_HASH}`);
	expect(res.status).toBe(302);
	expect(res.headers.get("location")).toBe(`/${USERNAME}/${ALIAS_HASH}`);
	// The warm rides waitUntil (absent in tests — the promise floats);
	// give it a beat, then confirm the next visitor's /h would hit.
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(warmed).toBe(1);

	// A rescued cast without a username lands in the same /u tail as a
	// shim-found one.
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === `https://shim.artlu.xyz/h/${ALIAS_HASH}`) {
			return Response.json({ success: false });
		}
		if (url === `https://farcaster.tv/~/${ALIAS_HASH}`) {
			return Response.json({
				result: { casts: [{ hash: ALIAS_HASH, author: { fid: FID } }] },
			});
		}
		if (url === "https://shim.artlu.xyz/u/3319217") {
			return Response.json({ success: true, username: USERNAME });
		}
		throw new Error(`Unexpected fetch in test: ${url}`);
	}) as typeof fetch;
	const noName = await app.request(`/~/conversations/${ALIAS_HASH}`);
	expect(noName.status).toBe(302);
	expect(noName.headers.get("location")).toBe(`/${USERNAME}/${ALIAS_HASH}`);
});

test("alias: the rescue's miss is the authoritative 404; its failure is unknown ⇒ 503", async () => {
	// farcaster.tv resolves the live chain — only ITS miss is a verdict.
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === `https://shim.artlu.xyz/h/${ALIAS_HASH}`) {
			return Response.json({ success: false });
		}
		if (url === `https://farcaster.tv/~/${ALIAS_HASH}`) {
			return new Response("not found", { status: 404 });
		}
		throw new Error(`Unexpected fetch in test: ${url}`);
	}) as typeof fetch;
	const miss = await app.request(`/~/conversations/${ALIAS_HASH}`);
	expect(miss.status).toBe(404);

	// A rescue transport failure is not a verdict — unknown ⇒ 503
	// (the cast may exist; retry is meaningful).
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === `https://shim.artlu.xyz/h/${ALIAS_HASH}`) {
			return Response.json({ success: false });
		}
		if (url === `https://farcaster.tv/~/${ALIAS_HASH}`) {
			throw new Error("farcaster.tv unreachable");
		}
		throw new Error(`Unexpected fetch in test: ${url}`);
	}) as typeof fetch;
	const down = await app.request(`/~/conversations/${ALIAS_HASH}`);
	expect(down.status).toBe(503);
});

test("alias: username-less with /u miss ⇒ 404; shim down ⇒ 503", async () => {
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

	// Shim down ⇒ 503 + Retry-After — a transport failure never rescues
	// (only an HTTP-200 miss proves the index was consulted and is cold).
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

// --- /c/{40 bare hex} + /cast/{40 bare hex}: hash-only aliases ---------------
//
// Quilcast (`/c/`) and linkcast (`/cast/`) bare-hex shapes are equally valid.
// Disambiguation with the username+hash cast route: /{prefix}/{bare40} is
// hash-only (prepend 0x → same resolve as /~/conversations); /{prefix}/0x…
// is fname `c` / `cast` + hash and must never take these aliases.

test("/c/{40 bare hex} 302s to the canonical cast waypoint", async () => {
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/h/${ALIAS_HASH}`]: {
			success: true,
			cast: ALIAS_CAST,
		},
	});
	const res = await app.request(`/c/${ALIAS_HASH.slice(2)}`);
	expect(res.status).toBe(302);
	expect(res.headers.get("location")).toBe(`/${USERNAME}/${ALIAS_HASH}`);
});

test("/cast/{40 bare hex} 302s to the canonical cast waypoint", async () => {
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/h/${ALIAS_HASH}`]: {
			success: true,
			cast: ALIAS_CAST,
		},
	});
	const res = await app.request(`/cast/${ALIAS_HASH.slice(2)}`);
	expect(res.status).toBe(302);
	expect(res.headers.get("location")).toBe(`/${USERNAME}/${ALIAS_HASH}`);
});

test("/c/{40 bare hex} rejects non-40 lengths (no upstream calls)", async () => {
	let calls = 0;
	globalThis.fetch = mock(async () => {
		calls++;
		throw new Error("Unexpected fetch in test");
	}) as typeof fetch;
	// Too short / too long: the regex gate never matches, so no /h probe.
	expect((await app.request("/c/abcd")).status).toBe(404);
	expect(
		(await app.request(`/c/${ALIAS_HASH.slice(2)}ff`)).status,
	).toBe(404);
	expect(calls).toBe(0);
});

test("/cast/{40 bare hex} rejects non-40 lengths (no upstream calls)", async () => {
	let calls = 0;
	globalThis.fetch = mock(async () => {
		calls++;
		throw new Error("Unexpected fetch in test");
	}) as typeof fetch;
	expect((await app.request("/cast/abcd")).status).toBe(404);
	expect(
		(await app.request(`/cast/${ALIAS_HASH.slice(2)}ff`)).status,
	).toBe(404);
	expect(calls).toBe(0);
});

test("/c/0x… stays the username+hash cast route (fname c), not the alias", async () => {
	const calls: string[] = [];
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		calls.push(url);
		if (url.startsWith("https://shim.artlu.xyz/h/")) {
			throw new Error("hash-only alias must not handle /c/0x…");
		}
		// Cast-route race legs for username `c` — miss cleanly so the cast
		// page answers 404 (proves we took /{username}/{hash}, not a 302).
		if (
			url.startsWith("https://shim.artlu.xyz/wc/c/") ||
			url.startsWith(`https://farcaster.tv/c/`)
		) {
			return url.startsWith("https://farcaster.tv/")
				? new Response("", { status: 404 })
				: Response.json({ success: false });
		}
		if (url === "https://shim.artlu.xyz/f/c") {
			return Response.json({ success: false });
		}
		throw new Error(`Unexpected fetch in test: ${url}`);
	}) as typeof fetch;
	const res = await app.request(`/c/${ALIAS_HASH}`);
	expect(res.status).toBe(404);
	expect(res.headers.get("location")).toBeNull();
	expect(calls.some((u) => u.includes("/h/"))).toBe(false);
	expect(
		calls.some(
			(u) =>
				u.startsWith("https://shim.artlu.xyz/wc/c/") ||
				u.startsWith("https://farcaster.tv/c/"),
		),
	).toBe(true);
});

test("/cast/0x… stays the username+hash cast route (fname cast), not the alias", async () => {
	const calls: string[] = [];
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		calls.push(url);
		if (url.startsWith("https://shim.artlu.xyz/h/")) {
			throw new Error("hash-only alias must not handle /cast/0x…");
		}
		if (
			url.startsWith("https://shim.artlu.xyz/wc/cast/") ||
			url.startsWith(`https://farcaster.tv/cast/`)
		) {
			return url.startsWith("https://farcaster.tv/")
				? new Response("", { status: 404 })
				: Response.json({ success: false });
		}
		if (url === "https://shim.artlu.xyz/f/cast") {
			return Response.json({ success: false });
		}
		throw new Error(`Unexpected fetch in test: ${url}`);
	}) as typeof fetch;
	const res = await app.request(`/cast/${ALIAS_HASH}`);
	expect(res.status).toBe(404);
	expect(res.headers.get("location")).toBeNull();
	expect(calls.some((u) => u.includes("/h/"))).toBe(false);
	expect(
		calls.some(
			(u) =>
				u.startsWith("https://shim.artlu.xyz/wc/cast/") ||
				u.startsWith("https://farcaster.tv/cast/"),
		),
	).toBe(true);
});

// --- /~/profiles/{fid}: farcaster's fid-profile shape, canonicalized ----------

test("/~/profiles/{fid} 302s to the canonical profile waypoint", async () => {
	globalThis.fetch = shimMock({
		"https://shim.artlu.xyz/u/10215": { success: true, username: USERNAME },
	});
	const res = await app.request("/~/profiles/10215");
	expect(res.status).toBe(302);
	// Relative Location (dual-serve hosts stay self-contained); the target
	// is the PRIMARY handle — shim /u is fname-first.
	expect(res.headers.get("location")).toBe(`/${USERNAME}`);
});

test("/~/profiles/{fid}: /u 200-miss ⇒ 404; non-2xx/throw ⇒ 503 + Retry-After", async () => {
	// HTTP 200 with no username — the index was consulted, the verdict
	// is real.
	globalThis.fetch = shimMock({
		"https://shim.artlu.xyz/u/10215": { success: true },
	});
	expect((await app.request("/~/profiles/10215")).status).toBe(404);

	// A non-2xx is an outage signal, NOT a miss — profile-family
	// discipline (one retry, then 503).
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === "https://shim.artlu.xyz/u/10215") {
			return new Response("boom", { status: 500 });
		}
		throw new Error(`Unexpected fetch in test: ${url}`);
	}) as typeof fetch;
	const notOk = await app.request("/~/profiles/10215");
	expect(notOk.status).toBe(503);
	expect(notOk.headers.get("retry-after")).toBe("60");

	// Transport failure — same unknown ⇒ 503 (retry included).
	let calls = 0;
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === "https://shim.artlu.xyz/u/10215") {
			calls++;
			throw new Error("shim unavailable");
		}
		throw new Error(`Unexpected fetch in test: ${url}`);
	}) as typeof fetch;
	const down = await app.request("/~/profiles/10215");
	expect(down.status).toBe(503);
	expect(down.headers.get("retry-after")).toBe("60");
	expect(calls).toBe(2); // withOneRetry: the 8s window rides one retry
});

test("/~/profiles/{username} canonicalizes with zero fetches", async () => {
	let calls = 0;
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		calls++;
		throw new Error(`Unexpected fetch in test: ${input}`);
	}) as typeof fetch;
	// Capitals ride the profile gate: the redirect target is lowercased.
	const capped = await app.request("/~/profiles/Decent-Artlu");
	expect(capped.status).toBe(302);
	expect(capped.headers.get("location")).toBe(`/${USERNAME}`);
	expect(calls).toBe(0);
});

test("/~/profiles: garbage shapes 404 with zero upstream fetches", async () => {
	let calls = 0;
	globalThis.fetch = mock(async () => {
		calls++;
		throw new Error("Unexpected fetch in test");
	}) as typeof fetch;
	// Beyond Number.MAX_SAFE_INTEGER — the digits are a lie.
	expect(
		(await app.request("/~/profiles/99999999999999999999")).status,
	).toBe(404);
	// The route's charset pattern never matches this — Hono's own 404.
	expect((await app.request("/~/profiles/bad!id")).status).toBe(404);
	// The trailing-slash form 301s to the canonical alias (query kept).
	const slashed = await app.request("/~/profiles/10215/?format=json");
	expect(slashed.status).toBe(301);
	expect(slashed.headers.get("location")).toBe("/~/profiles/10215?format=json");
	expect(calls).toBe(0);
});

// --- Phase 2: the stateful layer (badge + auto-open on the user routes) -------

const signedTrueMock = () =>
	shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: { success: true, user: USER },
		[`https://shim.artlu.xyz/signed/${FID}`]: { success: true, signed: true },
	});

test("profile menu: cookie-blind shell — resolution is client-side", async () => {
	globalThis.fetch = signedTrueMock();
	const bare = await app.request(`/${USERNAME}`);
	const bareBody = await bare.text();
	// Offered pills render server-side (gates applied); the badge and
	// data-resolved are applied by SHELL_SCRIPT from the local cookie —
	// the same bytes ship with or without it.
	expect(bareBody).not.toContain('class="pill-badge"');
	expect(bareBody).not.toContain("data-resolved=");
	const personal = await app.request(`/${USERNAME}`, {
		headers: { Cookie: "fc_client=farcaster|p:quilcast" },
	});
	expect(await personal.text()).toBe(bareBody);
	const quilcast = bareBody.indexOf('data-client="quilcast"');
	const farcaster = bareBody.indexOf('data-client="farcaster"');
	expect(quilcast).toBeGreaterThan(-1);
	expect(farcaster).toBeGreaterThan(-1);
});

test("profile menu ships the client sheet — trigger, dialog, toggle", async () => {
	globalThis.fetch = signedTrueMock();
	const res = await app.request(`/${USERNAME}`);
	const body = await res.text();
	expect(body).toContain('<dialog class="sheet"');
	expect(body).toContain("data-sheet-open");
	expect(body).toContain("data-sheet-auto");
	// The in-sheet row keeps the kind attr SHELL_PREP reads (data-resolved
	// is stamped client-side from the local cookie).
	expect(body).toContain('<p class="actions" data-kind="profile"');
	// The sheet script ships on the profile belt too.
	expect(body).toContain("showModal");
});

test("profile auto-open: client-side — the shell ships the kind-aware mount + machinery", async () => {
	globalThis.fetch = signedTrueMock();
	const res = await app.request(`/${USERNAME}`, {
		headers: { Cookie: "fc_client=farcaster|auto-on" },
	});
	const body = await res.text();
	// The mount carries the kind + noun; the box is built client-side.
	expect(body).toContain('id="auto-mount" data-kind="profile" data-noun="profiles"');
	const markup = withoutScripts(body);
	expect(markup).not.toContain('data-auto="on"');
	expect(markup).not.toContain("data-auto-noun");
	// The machinery ships: kind-aware decision (the mount's kind drives the
	// serialized fn), the profile target URLs as pill attributes for the
	// script to read, and AUTO_SCRIPT's noun-driven copy.
	expect(body).toContain(`decide(raw || undefined, pills, noredirect, kind)`);
	expect(body).toContain(`data-scheme="quorummobile://feed?profileFid=`);
	expect(body).toContain('"profiles"');
});

test("profile auto-open: an incapable cast slug goes idle client-side — generic copy", async () => {
	globalThis.fetch = signedTrueMock();
	const res = await app.request(`/${USERNAME}`, {
		headers: { Cookie: "fc_client=fatline|auto-on" },
	});
	const body = await res.text();
	// fatline has no profile target: flat inheritance finds nothing ⇒ the
	// client script renders the generic idle chip into the mount; the
	// server markup stays silent (no redirect targets, no box, no badge).
	const markup = withoutScripts(body);
	expect(markup).not.toContain("data-auto-url");
	expect(markup).not.toContain('data-resolved="');
	expect(markup).not.toContain('data-auto="on"');
	// The generic idle copy ships in the script source (Q3: no title map).
	expect(body).toContain("offered here");
	expect(body).not.toContain("Fatline isn&#39;t offered here");
	expect(body).toContain('data-client="farcaster" data-kind="profile"');
});

test("profile auto-open: a cast slug with a profile target resolves — linkcast", async () => {
	globalThis.fetch = signedTrueMock();
	const res = await app.request(`/${USERNAME}`, {
		headers: { Cookie: "fc_client=linkcast|auto-on" },
	});
	const body = await res.text();
	// linkcast gained profile/feed targets (Nov 2026): the pill ships in
	// the offered row and the client script resolves the cookie's head
	// slug against it (the server stays cookie-blind — the stateful layer
	// is client-side, so the markup still carries no redirect targets).
	const markup = withoutScripts(body);
	expect(markup).not.toContain("data-auto-url");
	expect(markup).not.toContain('data-resolved="');
	expect(markup).not.toContain('data-auto="on"');
	expect(body).toContain(
		`class="pill client-pill" href="https://linkcast.xyz/u/${USERNAME}" data-client="linkcast" data-kind="profile"`,
	);
});

test("profile auto-open: ?noredirect=1 rides the shell; the script reads location.search", async () => {
	globalThis.fetch = signedTrueMock();
	const res = await app.request(`/${USERNAME}?noredirect=1`, {
		headers: { Cookie: "fc_client=farcaster|auto-on" },
	});
	const body = await res.text();
	const markup = withoutScripts(body);
	expect(markup).not.toContain('data-auto="on"');
	expect(markup).not.toContain('data-auto="noredirect"');
	expect(body).toContain("noredirect=1");
});

test("unsigned profile: capable kind slugs still offered (the script resolves them)", async () => {
	globalThis.fetch = shimMock({
		[`https://shim.artlu.xyz/f/${USERNAME}`]: { success: true, fid: FID },
		[`https://shim.artlu.xyz/user/${FID}`]: { success: true, user: USER },
		[`https://shim.artlu.xyz/signed/${FID}`]: { success: true, signed: false },
	});
	const res = await app.request(`/${USERNAME}`, {
		headers: { Cookie: "fc_client=linkcast|p:quilcast|auto-on" },
	});
	const body = await res.text();
	// quilcast's profile target is unsigned-friendly; the kind-aware
	// client decision resolves p:quilcast — the head slug (linkcast,
	// itself capable for profiles since Nov 2026) is outranked by the
	// kind pref — against the offered pills, which are server-gated
	// (farcaster suppressed, quilcast offered).
	expect(body).not.toContain('data-client="farcaster"');
	expect(body).toContain(`href="https://quilcast.com/u/${USERNAME}"`);
	expect(body).toContain('data-client="quilcast" data-kind="profile"');
});

// --- Post-hardfork fid waterfall (HyperSnap) ----------------------------------
//
// The hard fork extended the fid space at 2**32; Warpcast mints /{fid}
// profile and /{fid}/{hash} cast URLs for accounts that hold no username
// yet. Username resolution stays the first verdict (all-digit fnames
// genuinely exist), so the waterfall here runs only after the /f miss —
// and renders IN PLACE, because there is no username to redirect to.

import { numericFidCandidate } from "./shim.ts";

const FORK_FID = 4294967296;
const FORK_USER = {
	fid: FORK_FID,
	username: null,
	fname: null,
	displayName: "2^32",
	pfpUrl: null,
	bio: "The first native FID on HyperSnap.",
	primaryAddress: null,
};

/** The username legs' verdict for a usernameless post-fork fid: /f misses. */
function forkMisses(): Record<string, unknown | Error> {
	return {
		[`https://shim.artlu.xyz/f/${FORK_FID}`]: { success: false },
	};
}

test("numericFidCandidate: the post-fork gate", () => {
	// Above the gate: candidates.
	expect(numericFidCandidate("4294967296")).toBe(4294967296);
	expect(numericFidCandidate("4000001")).toBe(4000001);
	// At/below the gate: an all-digit fname, full stop — no fid reading.
	expect(numericFidCandidate("4000000")).toBeUndefined();
	expect(numericFidCandidate("627569")).toBeUndefined();
	// Not digits, or digits past Number precision.
	expect(numericFidCandidate("12abc")).toBeUndefined();
	expect(numericFidCandidate("99999999999999999999")).toBeUndefined();
	expect(numericFidCandidate("")).toBeUndefined();
});

test("fid-shaped profile URL renders the post-fork entity in place", async () => {
	globalThis.fetch = shimMock({
		...forkMisses(),
		[`https://shim.artlu.xyz/user/${FORK_FID}`]: {
			success: true,
			user: FORK_USER,
		},
		[`https://shim.artlu.xyz/signed/${FORK_FID}`]: {
			success: true,
			signed: false,
		},
	});
	const res = await app.request(`/${FORK_FID}`);
	expect(res.status).toBe(200);
	const body = await res.text();
	expect(body).toContain("2^32");
	expect(body).toContain("The first native FID on HyperSnap.");
	expect(body).toContain(`fid ${FORK_FID}`);
	// signed:false renders the read-only notice, same as the username path.
	expect(body).toContain("hasn't signed the social smart contract");
});

test("fid-shaped profile JSON twin serves the entity identity-only", async () => {
	globalThis.fetch = shimMock({
		...forkMisses(),
		[`https://shim.artlu.xyz/user/${FORK_FID}`]: {
			success: true,
			user: FORK_USER,
		},
		[`https://shim.artlu.xyz/signed/${FORK_FID}`]: {
			success: true,
			signed: true,
		},
	});
	const res = await app.request(`/${FORK_FID}?format=json`);
	expect(res.status).toBe(200);
	const body = (await res.json()) as Record<string, unknown>;
	expect(body.fid).toBe(FORK_FID);
	expect(body.username).toBe(`${FORK_FID}`);
	expect(body.displayName).toBe("2^32");
	expect(body.casts).toBeUndefined();
	expect("note" in body).toBe(false);
	expect(body.farcaster).toBe(`https://farcaster.xyz/${FORK_FID}`);
});

test("fid-shaped casts-and-replies renders the identity head as a feed waypoint", async () => {
	globalThis.fetch = shimMock({
		...forkMisses(),
		[`https://shim.artlu.xyz/user/${FORK_FID}`]: {
			success: true,
			user: FORK_USER,
		},
		[`https://shim.artlu.xyz/signed/${FORK_FID}`]: {
			success: true,
			signed: true,
		},
	});
	const res = await app.request(`/${FORK_FID}/casts-and-replies`);
	expect(res.status).toBe(200);
	const body = await res.text();
	expect(body).toContain("2^32");
	expect(body).toContain('data-kind="feed"');
	expect(body).not.toContain("Recent casts are unavailable");
	expect(body).not.toContain('class="farcaster-embed');
});

test("small numeric username stays a plain 404 — the waterfall never fires below the gate", async () => {
	const fetchMock = shimMock({
		"https://shim.artlu.xyz/f/1234567": { success: false },
	});
	globalThis.fetch = fetchMock;
	const res = await app.request("/1234567");
	expect(res.status).toBe(404);
	// Exactly one upstream call (/f): /user/1234567 must never be probed.
	expect(fetchMock.mock.calls.length).toBe(1);
});

test("fid leg miss keeps the username verdict (404 render)", async () => {
	globalThis.fetch = shimMock({
		...forkMisses(),
		// The sparse unknown-fid shape: success with no numeric fid — miss.
		[`https://shim.artlu.xyz/user/${FORK_FID}`]: {
			success: true,
			user: { fid: null, username: null },
		},
	});
	const res = await app.request(`/${FORK_FID}`);
	expect(res.status).toBe(404);
});

test("/~/profiles/{fid} for a usernameless fid 302s to the fid surface", async () => {
	globalThis.fetch = shimMock({
		// shim /u answers the fid (success) with no username — the
		// post-fork shape. No username waypoint exists to redirect to.
		[`https://shim.artlu.xyz/u/${FORK_FID}`]: { success: true },
	});
	const res = await app.request(`/~/profiles/${FORK_FID}`);
	expect(res.status).toBe(302);
	expect(res.headers.get("location")).toBe(`/${FORK_FID}`);
});
