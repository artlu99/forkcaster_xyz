import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { LAST_CLIENT_COOKIE } from "./clients.ts";
import {
	renderCastHtml,
	renderCastJson,
	renderQuotesFragment,
	resolveCast,
} from "./cast-page.tsx";

export const app = new Hono<{ Bindings: Env }>();

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
	);
	return c.html(html, status);
});

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
