import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
	renderChannelHtml,
	renderChannelJson,
	resolveChannel,
} from "./channel-page.tsx";
import {
	renderCastHtml,
	renderCastJson,
	renderQuotesFragment,
	resolveCast,
} from "./cast-page.tsx";
import {
	isAutoDelay,
	LAST_CLIENT_COOKIE,
	LAST_CLIENT_MAX_AGE,
	mergeClientCookie,
	parseClientCookie,
} from "./clients.ts";
import { getRankSnapshot, getRankSnapshotSoon } from "./client-rank-store.ts";
import { mcpLandingHtml, mcpHandler } from "./mcp.ts";
import {
	renderCastsHtml,
	renderProfileHtml,
	renderProfileJson,
	resolveConversationAlias,
	resolveProfile,
} from "./profile-page.tsx";
import { getRaceStatsSnapshot } from "./race-stats-store.ts";
import { parseTrackEvent, writeTrackEvent } from "./track.ts";
import { renderTransparencyHtml, transparencyJson } from "./transparency.tsx";

export const app = new Hono<{ Bindings: Env }>();

/**
 * Shared JSON negotiation for every SSR+JSON twin route (cast, profile,
 * channel, transparency): ?format=json is the explicit agent switch and
 * wins over Accept; only a strict application/json Accept also negotiates
 * JSON — a wildcard Accept stays HTML. One expression, four routes: the
 * /api/ index advertises them as siblings, so they must negotiate
 * identically.
 */
function negotiatesJson(c: Context<{ Bindings: Env }>): boolean {
	return (
		c.req.query("format") === "json" ||
		(c.req.header("Accept") ?? "").includes("application/json")
	);
}

// Auto-open preference write. Server `Set-Cookie` (not document.cookie)
// keeps the preference exempt from Safari ITP's ~7-day cap on
// script-set cookies. Dumb: validate → Set-Cookie → 204.
app.post("/prefs", async (c) => {
	const body = (await c.req.json().catch(() => undefined)) as
		| { auto?: unknown; delay?: unknown }
		| undefined;
	const auto = body?.auto;
	const delay = body?.delay;
	const hasAuto = auto === "on" || auto === "off";
	const hasDelay = isAutoDelay(delay);
	if ((auto !== undefined && !hasAuto) || (delay !== undefined && !hasDelay)) {
		return c.body(null, 400);
	}
	if (!hasAuto && !hasDelay) return c.body(null, 400);
	const value = mergeClientCookie(getCookie(c, LAST_CLIENT_COOKIE), {
		...(hasAuto ? { auto } : {}),
		...(hasDelay ? { delay } : {}),
	});
	setCookie(c, LAST_CLIENT_COOKIE, value, {
		path: "/",
		maxAge: LAST_CLIENT_MAX_AGE,
		sameSite: "Lax",
		// HTTPS-only in prod; localhost dev is a secure context.
		secure: true,
	});
	return c.body(null, 204);
});

// Client click-through telemetry (PLAN3): one allow-listed, anonymous
// event per client selection — slug, kind (pill / auto / go-now),
// transport, coarse device class, host. No cookies are read here (the
// first/switch flag is computed client-side BEFORE the click rewrites
// the cookie); no cast ids, IPs, or identifiers of any kind — the
// negative list is the privacy design and /transparency declares it.
// Invalid bodies are indistinguishable from valid ones: 204 either way,
// no error side-channel.
app.post("/t", async (c) => {
	const event = parseTrackEvent(await c.req.text().catch(() => ""));
	if (event) {
		try {
			const dataset = c.env.CLICK_STATS;
			if (dataset) {
				c.executionCtx.waitUntil(
					Promise.resolve(
						writeTrackEvent(dataset, event, new URL(c.req.url).hostname),
					),
				);
			}
		} catch {
			// No executionCtx (tests) — telemetry is best-effort.
		}
	}
	return c.body(null, 204);
});

// Reserved single-segment paths (/api/, /transparency, /prefs, /t,
// /race-stats.json, /mcp) are exact-match and registered before the
// parametric cast route; cast URLs are always two-segment, so a Farcaster
// user literally named "transparency" is unaffected (/transparency/0x…
// still routes to the cast handler).
app.post("/mcp", (c) => mcpHandler.fetch(c.req.raw));
app.get("/mcp", (c) => {
	// MCP clients probe GET for a server-initiated SSE stream (explicit
	// text/event-stream accept) — answer with protocol semantics. Browsers
	// and link crawlers get a shareable OG-tagged server card instead.
	if ((c.req.header("Accept") ?? "").includes("text/event-stream")) {
		return c.body(null, 405, { Allow: "POST" });
	}
	return c.html(mcpLandingHtml());
});

app.get("/transparency", async (c) => {
	const wantsJson = negotiatesJson(c);
	// Two cacheTtl'd reads (per-isolate) feed the HTML page and the JSON
	// twin; absent/unreachable snapshots → dashes/coming-soon. Silent.
	const snapshot = await getRaceStatsSnapshot(c.env);
	const rank = await getRankSnapshot(c.env);
	if (wantsJson) return c.json(transparencyJson(snapshot, rank));
	const primaryOrigin = (c.env as Env | undefined)?.PRIMARY_ORIGIN;
	return c.html(
		renderTransparencyHtml({
			canonicalUrl: primaryOrigin ? `${primaryOrigin}/transparency` : undefined,
			snapshot,
			rank,
		}),
	);
});

// Raw agent-facing snapshot — the same cached read the transparency page
// uses, no rendering. 404 when there is no snapshot to serve.
app.get("/race-stats.json", async (c) => {
	const snapshot = await getRaceStatsSnapshot(c.env);
	if (snapshot === null) return c.body(null, 404);
	return c.json(snapshot, 200, { "cache-control": "public, max-age=21600" });
});

// Agent-facing index: the JSON surfaces this worker serves.
app.get("/api/", (c) =>
	c.json({
		cast: "/{username}/{hash}?format=json",
		profile: "/{username}?format=json",
		channel: "/channel/{id}?format=json",
		raceStats: "/race-stats.json",
		transparency: "/transparency?format=json",
	}),
);

// Channel landing pages (PLAN5). The literal `channel` and `~/channel`
// prefixes are registered BEFORE the two-segment cast route: Hono matches
// in registration order, so even a hash-shaped id (/channel/0xabc…) routes
// here rather than to the cast handler. Accepted shadow tradeoff (same
// family as /transparency): a cast belonging to a Farcaster user literally
// named "channel" is shadowed. Waypoint law, identity-only: the recent-casts
// skeleton is deferred until a cheap feed exists (shim's measured 8–15s+,
// PLAN5 §4); zero scripts, zero cookies, zero telemetry. The charset gate
// 404s garbage with zero upstream fetches; ids lowercase before lookup.
const CHANNEL_ID_PATTERN = /^[a-zA-Z0-9._-]{1,30}$/;

/** Shared channel-surface gate: charset, lowercased. null ⇒ 404. */
function gateChannelId(raw: string): string | null {
	if (!CHANNEL_ID_PATTERN.test(raw)) return null;
	return raw.toLowerCase();
}

async function channelLanding(c: Context<{ Bindings: Env }>) {
	const id = gateChannelId(c.req.param().id);
	if (id === null) {
		return c.body(null, 404);
	}
	// Resolve once, render twice — same negotiation as the cast/profile
	// routes: ?format=json wins over Accept; only strict application/json
	// Accept also negotiates JSON.
	const wantsJson = negotiatesJson(c);
	const resolved = await resolveChannel(id);
	if (wantsJson) {
		const { status, body, retryAfter } = renderChannelJson(resolved, id);
		return c.json(
			body,
			status,
			retryAfter ? { "retry-after": retryAfter } : undefined,
		);
	}
	const { status, html } = renderChannelHtml(
		resolved,
		id,
		(c.env as Env | undefined)?.PRIMARY_ORIGIN,
	);
	// Retry-After rides the 503 in both variants (identity has no fail-open
	// source — unlike casts, there is nothing to render without the API).
	return c.html(
		html,
		status,
		status === 503 ? { "retry-after": "60" } : undefined,
	);
}

// Both farcaster.xyz URL shapes render the same page; canonical + og:url
// always carry the /channel/{id} form (the /~/ shape is an alias, not a
// second identity).
app.get("/channel/:id{[a-zA-Z0-9._-]{1,30}}", (c) => channelLanding(c));
app.get("/~/channel/:id{[a-zA-Z0-9._-]{1,30}}", (c) => channelLanding(c));

app.get("/:username/:hash{0x[0-9a-fA-F]+}", async (c) => {
	const { username, hash } = c.req.param();
	// SSR fragment for the quote fill-in script (partial, quote-blind wins).
	// Our own script is the only intended consumer; responses are no-store.
	if (c.req.query("embeds") === "quotes") {
		const fragment = await renderQuotesFragment(username, hash);
		return c.html(fragment.html, fragment.status, {
			"cache-control": "no-store",
		});
	}
	// Resolve once, render twice: one fetch pipeline serves both variants.
	// ?format=json is the explicit agent switch and wins over Accept; only a
	// strict application/json Accept also negotiates JSON — browsers and
	// curl send */*, which stays HTML. HTML races the provider roster with
	// a 700ms completeness box (cast-source.ts); JSON stays shim-only.
	const wantsJson = negotiatesJson(c);
	const resolved = await resolveCast(username, hash, c.env, {
		boxMs: wantsJson ? null : 700,
	});
	// Non-blocking race telemetry: one Analytics Engine datapoint per
	// resolve (index = winner/kind; doubles = total ms, box, partial flag;
	// blob = per-provider outcomes). Guarded: tests and other callers
	// without an executionCtx or the binding simply skip it.
	try {
		const dataset = c.env.RACE_STATS;
		if (dataset) {
			c.executionCtx.waitUntil(
				Promise.resolve(
					dataset.writeDataPoint({
						indexes: [
							resolved.kind === "found" ? resolved.provider : resolved.kind,
						],
						blobs: [
							resolved.timings
								.map((t) => `${t.provider}:${t.kind}:${t.ms}`)
								.join(","),
							wantsJson ? "json" : "html",
							// Dual-serve: attribute the datapoint to the host.
							new URL(c.req.url).hostname,
						],
						doubles: [
							resolved.elapsedMs,
							wantsJson ? -1 : 700,
							resolved.kind === "found" && resolved.partial ? 1 : 0,
						],
					}),
				),
			);
		}
	} catch {
		// No executionCtx (tests) — telemetry is best-effort.
	}
	if (wantsJson) {
		const { status, body, retryAfter } = renderCastJson(
			resolved,
			username,
			hash,
			new URL(c.req.url).origin,
		);
		return c.json(
			body,
			status,
			retryAfter ? { "retry-after": retryAfter } : undefined,
		);
	}
	// The last-used client cookie badges the visitor's preferred pill.
	// Last-used client + auto-open preference from the single cookie.
	const prefs = parseClientCookie(getCookie(c, LAST_CLIENT_COOKIE));
	// Pill order rides the rank snapshot through a per-isolate TTL store;
	// getRankSnapshotSoon caps a cold refresh at 400ms — still trivial next
	// to the 700ms race box, while converting most cold-isolate misses into
	// hits (a cold lmdis GET is usually one round trip once connected).
	// Registry order on timeout.
	const rank = await getRankSnapshotSoon(c.env, 400);
	const { status, html } = await renderCastHtml(
		resolved,
		username,
		hash,
		prefs,
		(c.env as Env | undefined)?.PRIMARY_ORIGIN,
		c.req.query("noredirect") === "1",
		rank,
	);
	return c.html(html, status);
});

// Profile landing pages (PLAN4) — the FIRST parametric single-segment route,
// registered LAST: Hono matches in registration order, so every exact
// reserved route above and the two-segment cast route keep winning (a
// Farcaster user literally named "transparency" is shadowed — the same
// accepted tradeoff the cast route documents). Waypoint law: identity card +
// routing skeleton; no pills, no auto-open, no cookies, no telemetry. The
// charset gate and bot-path denylist 404 garbage with zero upstream fetches —
// every shim call costs a lookup, so noise never leaves the worker.
const PROFILE_BOT_PATHS = new Set([
	"favicon.ico",
	"robots.txt",
	"sitemap.xml",
	"apple-touch-icon.png",
	"manifest.json",
	"humans.txt",
]);
const PROFILE_USERNAME_PATTERN = /^[a-zA-Z0-9._-]{1,20}$/;

/** Shared profile-surface gate: bot paths + charset, lowercased. null ⇒ 404. */
function gateProfileUsername(raw: string): string | null {
	// A blanket extension ban would be wrong (usernames can contain dots) —
	// the denylist is exact-match on the paths that actually get probed.
	if (PROFILE_BOT_PATHS.has(raw.toLowerCase())) return null;
	if (!PROFILE_USERNAME_PATTERN.test(raw)) return null;
	// People type capitals; Farcaster fnames are lowercase.
	return raw.toLowerCase();
}

// Trailing-slash normalization (owner ask): the parametric patterns above
// are exact, so /{username}/ and /{username}/casts-and-replies/ would
// otherwise 404. 301 to the canonical non-slash forms — syntactic and
// permanent, so the redirect is safely cacheable — with the query string
// riding along (?format=json survives). Zero upstream fetches: the gate
// runs, the redirect answers.
app.get("/:username{[a-zA-Z0-9._-]{1,20}}/", (c) => {
	const username = gateProfileUsername(c.req.param().username);
	if (username === null) {
		return c.body(null, 404);
	}
	const search = new URL(c.req.url).search;
	return c.redirect(`/${username}${search}`, 301);
});
app.get("/:username{[a-zA-Z0-9._-]{1,20}}/casts-and-replies/", (c) => {
	const username = gateProfileUsername(c.req.param().username);
	if (username === null) {
		return c.body(null, 404);
	}
	const search = new URL(c.req.url).search;
	return c.redirect(`/${username}/casts-and-replies${search}`, 301);
});

app.get("/:username{[a-zA-Z0-9._-]{1,20}}", async (c) => {
	const username = gateProfileUsername(c.req.param().username);
	if (username === null) {
		return c.body(null, 404);
	}
	// Resolve once, render twice — same negotiation as the cast route:
	// ?format=json wins over Accept; only strict application/json Accept
	// also negotiates JSON. The identity-card page skips the timeline call
	// entirely; the JSON twin keeps serving recent casts.
	const wantsJson = negotiatesJson(c);
	const resolved = await resolveProfile(username, {
		timeline: wantsJson,
		// The ban signal gates the way out: unsigned ⇒ Quorum/Quilcast pills.
		signed: true,
	});
	if (wantsJson) {
		const { status, body, retryAfter } = renderProfileJson(
			resolved,
			username,
			new URL(c.req.url).origin,
		);
		return c.json(
			body,
			status,
			retryAfter ? { "retry-after": retryAfter } : undefined,
		);
	}
	const { status, html } = renderProfileHtml(
		resolved,
		username,
		(c.env as Env | undefined)?.PRIMARY_ORIGIN,
	);
	// Retry-After rides the 503 in both variants (identity has no fail-open
	// source — unlike casts, there is nothing to render without shim).
	return c.html(
		html,
		status,
		status === 503 ? { "retry-after": "60" } : undefined,
	);
});

// The casts page (/{username}/casts-and-replies): the ONE list surface —
// every cast rendered in full through the individual cast page's pipeline
// (embed SSR + unfurl + quote hydration + per-card live-stats slot), with
// the profile's OG preview. Patterns are disjoint from the 0x-hashed cast
// route above; the /f verdict and fail-soft timeline match the profile.
app.get("/:username/casts-and-replies", async (c) => {
	const username = gateProfileUsername(c.req.param().username);
	if (username === null) {
		return c.body(null, 404);
	}
	const resolved = await resolveProfile(username, {
		timeline: true,
		// Same ban-signal fork as the profile page: the head's way out
		// follows the signed state.
		signed: true,
	});
	const { status, html } = await renderCastsHtml(
		resolved,
		username,
		(c.env as Env | undefined)?.PRIMARY_ORIGIN,
		c.env,
	);
	return c.html(
		html,
		status,
		status === 503 ? { "retry-after": "60" } : undefined,
	);
});

// Warpcast legacy thread shape (/~/conversations/0x…): the purest waypoint —
// no surface at all. Resolve via shim /h (misses answer HTTP 200
// {"success":false}; short hashes miss too — measured) and 302 — NOT 301, so
// the mapping stays cache-free — to the canonical /{username}/{fullHash} cast
// waypoint. Relative Location keeps dual-serve hosts self-contained.
app.get("/~/conversations/:hash{0x[0-9a-fA-F]+}", async (c) => {
	const resolved = await resolveConversationAlias(c.req.param().hash);
	if (resolved.kind === "unreachable") {
		return c.body(null, 503, { "retry-after": "60" });
	}
	if (resolved.kind === "not-found") {
		return c.body(null, 404);
	}
	return c.redirect(
		`/${encodeURIComponent(resolved.username)}/${resolved.fullHash}`,
		302,
	);
});

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
