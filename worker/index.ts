import { Hono } from "hono";
import { renderCastHtml, renderCastJson, resolveCast } from "./cast-page.tsx";

export const app = new Hono<{ Bindings: Env }>();

app.get("/api/", (c) => c.json({ name: "Cloudflare" }));

app.get("/:username/:hash{0x[0-9a-fA-F]+}", async (c) => {
	const { username, hash } = c.req.param();
	// Resolve once, render twice: one fetch pipeline serves both variants.
	// ?format=json is the explicit agent switch and wins over Accept; only a
	// strict application/json Accept also negotiates JSON — browsers and
	// curl send */*, which stays HTML.
	const wantsJson =
		c.req.query("format") === "json" ||
		(c.req.header("Accept") ?? "").includes("application/json");
	const resolved = await resolveCast(username, hash, c.env);
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
	const { status, html } = await renderCastHtml(resolved, username, hash);
	return c.html(html, status);
});

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
