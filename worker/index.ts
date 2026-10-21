import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { LAST_CLIENT_COOKIE } from "./clients.ts";
import {
	renderCastHtml,
	renderCastJson,
	renderQuotesFragment,
	resolveCast,
} from "./cast-page.tsx";
import { renderTransparencyHtml, transparencyJson } from "./transparency.tsx";

export const app = new Hono<{ Bindings: Env }>();

// Reserved single-segment paths (/api/, /transparency) are exact-match and
// registered before the parametric cast route; cast URLs are always
// two-segment, so a Farcaster user literally named "transparency" is
// unaffected (/transparency/0x… still routes to the cast handler).
app.get("/transparency", (c) => {
	const wantsJson =
		c.req.query("format") === "json" ||
		(c.req.header("Accept") ?? "").includes("application/json");
	if (wantsJson) return c.json(transparencyJson());
	const primaryOrigin = (c.env as Env | undefined)?.PRIMARY_ORIGIN;
	return c.html(
		renderTransparencyHtml({
			canonicalUrl: primaryOrigin
				? `${primaryOrigin}/transparency`
				: undefined,
		}),
	);
});

app.get("/api/", (c) => c.json({ name: "Cloudflare" }));

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
							resolved.kind === "found"
								? (resolved.provider ?? "none")
								: resolved.kind,
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
	const lastClientId = getCookie(c, LAST_CLIENT_COOKIE);
	const { status, html } = await renderCastHtml(
		resolved,
		username,
		hash,
		lastClientId,
		// app.request()-style callers may pass no env at all.
		(c.env as Env | undefined)?.PRIMARY_ORIGIN,
	);
	return c.html(html, status);
});

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
