// MCP server factory — the only file that imports the MCP SDK, so
// protocol/SDK churn can never reach resolution logic. Mounted at /mcp
// (index.ts) as a web-standard handler; the factory runs once per
// request — stateless.

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
	castRefInput,
	castRefOutput,
	runGetCastLink,
	type CastRefOutput,
} from "./cast-ref.ts";

export function createMcpServer(): McpServer {
	const server = new McpServer({ name: "forkcaster", version: "1.0.0" });
	server.registerTool("get_cast_link", {
		title: "Get cast link",
		description:
			"Resolve a Farcaster cast — identified by username/fid + short hash, or by its full 40-hex hash — and return the URL that opens it in a target Farcaster client app (or all supported apps). Also returns the author's signed-contract status; URLs are returned regardless of signed state.",
		inputSchema: castRefInput,
		outputSchema: castRefOutput,
	}, async (input) => {
		// Overall budget for a resolution chain (up to three shim hops).
		const outcome = await runGetCastLink(input, AbortSignal.timeout(8000));
		if (outcome.ok) {
			const result: CastRefOutput = outcome.result;
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				structuredContent: result,
			};
		}
		return {
			isError: true,
			content: [{ type: "text", text: `${outcome.code}: ${outcome.message}` }],
		};
	});
	return server;
}

export const mcpHandler = createMcpHandler(createMcpServer);

/**
 * GET /mcp — a shareable server card for browsers and link crawlers
 * (POST remains the protocol transport). Static, first-party constants
 * only: nothing from the request is reflected, so there is no injection
 * surface and every platform renders the same card.
 */
export function mcpLandingHtml(): string {
	const title = "forkcaster — MCP server for Farcaster casts";
	const description =
		"Resolve any Farcaster cast — by @username, fid, or hash — into shareable links for Farcaster, Firefly, Neynar, Quilcast, and Vibeshift. Public, no auth.";
	const endpoint = "https://forkcaster.xyz/mcp";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>forkcaster — MCP server</title>
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${description}" />
<meta property="og:image" content="https://forkcaster.xyz/mcp-card.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="forkcaster MCP server card — dark, stylized fork mark, get_cast_link" />
<meta property="og:url" content="${endpoint}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="forkcaster" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${title}" />
<meta name="twitter:description" content="${description}" />
<meta name="twitter:image" content="https://forkcaster.xyz/mcp-card.png" />
<link rel="canonical" href="${endpoint}" />
<style>
:root {
	color-scheme: light dark;
	--bg: #fbfbfa;
	--ink: #101014;
	--muted: #77747e;
	--line: #e8e6e3;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #0e0e12;
		--ink: #f0eff2;
		--line: #26262c;
	}
}
body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 20px; background: var(--bg); color: var(--ink); line-height: 1.5; }
a { color: var(--ink); }
code { background: var(--line); padding: 2px 6px; border-radius: 4px; }
h1 { font-size: 22px; }
h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-top: 28px; }
</style>
</head>
<body>
<h1>forkcaster MCP server</h1>
<p>An MCP (Model Context Protocol) server that turns Farcaster casts into shareable deep links — race-verified cast identity, every supported Farcaster client app, author signed-contract status included.</p>
<h2>Connect</h2>
<p>Point any MCP client at <code>${endpoint}</code> — Streamable HTTP, public, no auth.</p>
<h2>Tool — get_cast_link</h2>
<ul>
<li><strong>Identify a cast</strong>: full 40-hex hash on its own, or author (username or fid) + short hash.</li>
<li><strong>Pick a client</strong>: farcaster, quorum, firefly, neynar, quilcast, vibeshift — or all at once.</li>
<li><strong>Get</strong>: verified per-client URLs, the farcaster-canonical URL, and the author's signed status (pass-through — never suppressed).</li>
</ul>
<h2>More</h2>
<ul>
<li><a href="/transparency">Transparency</a> — what forkcaster is and what it tracks</li>
<li><a href="https://github.com/artlu99/forkcaster_xyz">Source</a> — MIT</li>
</ul>
</body>
</html>`;
}
