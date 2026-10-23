import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
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
import { getRaceStatsSnapshot } from "./race-stats-store.ts";
import { parseTrackEvent, writeTrackEvent } from "./track.ts";
import { renderTransparencyHtml, transparencyJson } from "./transparency.tsx";

export const app = new Hono<{ Bindings: Env }>();

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
	const wantsJson =
		c.req.query("format") === "json" ||
		(c.req.header("Accept") ?? "").includes("application/json");
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
		raceStats: "/race-stats.json",
		transparency: "/transparency?format=json",
	}),
);

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
	const wantsJson =
		c.req.query("format") === "json" ||
		(c.req.header("Accept") ?? "").includes("application/json");
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

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
