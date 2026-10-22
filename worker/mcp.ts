// MCP server factory — the only file that imports the MCP SDK, so
// protocol/SDK churn can never reach resolution logic (see PLAN3
// "Change vectors & stability policy"). Mounted at /mcp (index.ts) as a
// web-standard handler; the factory runs once per request — stateless.

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
