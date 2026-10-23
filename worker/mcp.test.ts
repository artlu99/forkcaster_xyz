/**
 * MCP endpoint tests: protocol handshake, tools/list advertisement,
 * tools/call for every accepted reference form (against exact-URL shim
 * mocks), zod rejections, and the degrade paths. globalThis.fetch is
 * mocked and routed by exact shim URL — unexpected URLs reject.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

const originalFetch = globalThis.fetch;

import { CLIENTS, type ClientDefinition } from "./client-registry.ts";
import { runGetCastLink, type ToolOutcome } from "./cast-ref.ts";
import type { ShimEmbed } from "./shim.ts";
import { mcpHandler } from "./mcp.ts";

const SHORT = "0x895ecc74";
const FULL = "0x895ecc7415208bfb6105a8cb675f391f19cb9e2c";
const FID = 10215;

type JsonRpcResponse = {
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
};

/**
 * The Streamable HTTP transport requires the dual Accept header and may
 * answer either as plain JSON or as an SSE stream whose final `data:`
 * frame carries the JSON-RPC message — tests accept both shapes.
 */
async function parseRpc(res: Response): Promise<JsonRpcResponse> {
	const contentType = res.headers.get("content-type") ?? "";
	if (contentType.includes("text/event-stream")) {
		const text = await res.text();
		const frames = text
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trim())
			.filter(Boolean);
		return JSON.parse(frames[frames.length - 1]) as JsonRpcResponse;
	}
	return (await res.json()) as JsonRpcResponse;
}

function rpc(method: string, params?: Record<string, unknown>, id = 1): Request {
	return new Request("https://forkcaster.xyz/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			// Streamable HTTP requires the client to accept both response types.
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify(
			params === undefined
				? { jsonrpc: "2.0", method }
				: { jsonrpc: "2.0", id, method, params },
		),
	});
}

async function callRpc(
	method: string,
	params?: Record<string, unknown>,
): Promise<JsonRpcResponse> {
	const res = await mcpHandler.fetch(rpc(method, params));
	return parseRpc(res);
}

/** Mock shim responses; unlisted paths reject (error-path coverage). */
function mockShim(routes: Record<string, unknown>): void {
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const path = String(input).replace("https://shim.artlu.xyz", "");
		if (path in routes) return Response.json(routes[path]);
		throw new Error(`unexpected shim fetch ${path}`);
	});
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("protocol", () => {
	test("initialize advertises the forkcaster server with tools capability", async () => {
		const json = await callRpc("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "test", version: "0" },
		});
		const result = json.result as {
			protocolVersion: string;
			serverInfo: { name: string };
			capabilities: { tools?: unknown };
		};
		expect(json.error).toBeUndefined();
		expect(result.serverInfo.name).toBe("forkcaster");
		expect(typeof result.protocolVersion).toBe("string");
		expect(result.capabilities.tools).toBeDefined();
	});

	test("tools/list advertises get_cast_link with the registry-derived client enum", async () => {
		const json = await callRpc("tools/list", {});
		const tools = (json.result as { tools: Array<Record<string, unknown>> }).tools;
		const tool = tools.find((t) => t.name === "get_cast_link");
		expect(tool).toBeDefined();
		const schema = JSON.stringify(tool?.inputSchema);
		for (const id of ["farcaster", "quorum", "firefly", "neynar", "quilcast", "vibeshift", "all"]) {
			expect(schema).toContain(id);
		}
	});
});

describe("tools/call get_cast_link", () => {
	test("username + shorthash → firefly URL (form A)", async () => {
		mockShim({
			"/wc/zoo/0x895ecc74": {
				success: true,
				cast: {
					fid: FID,
					hash: FULL,
					user: { fid: FID, username: "zoo" },
				},
			},
			"/signed/10215": { success: true, signed: true },
		});
		const json = await callRpc("tools/call", {
			name: "get_cast_link",
			arguments: { username: "zoo", shorthash: SHORT, client: "firefly" },
		});
		const result = json.result as {
			structuredContent: {
				url: string;
				canonical: string;
				signed: boolean;
				all: Record<string, string>;
			};
			isError?: boolean;
		};
		expect(json.error).toBeUndefined();
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent.url).toBe(
			`https://firefly.social/post/farcaster/${FULL}`,
		);
		expect(result.structuredContent.canonical).toBe(
			`https://farcaster.xyz/zoo/${SHORT}`,
		);
		expect(result.structuredContent.signed).toBe(true);
		// quilcast emits bare lowercase hex (no 0x) — its internal form.
		expect(result.structuredContent.all.quilcast).toBe(
			`https://quilcast.com/c/${FULL.slice(2)}`,
		);
	});

	test("longhash alone → resolves identity via /h (form B)", async () => {
		mockShim({
			[`/h/${FULL}`]: {
				success: true,
				cast: {
					fid: FID,
					hash: FULL,
					user: { fid: FID, username: "zoo" },
				},
			},
			"/signed/10215": { success: true, signed: false },
		});
		const json = await callRpc("tools/call", {
			name: "get_cast_link",
			arguments: { longhash: FULL, client: "all" },
		});
		const result = json.result as {
			structuredContent: {
				client: string;
				url: string | null;
				signed: boolean;
				resolved: { username: string; fullHash: string };
				all: Record<string, string>;
			};
		};
		expect(result.structuredContent.client).toBe("all");
		expect(result.structuredContent.url).toBeNull();
		expect(result.structuredContent.resolved.username).toBe("zoo");
		expect(result.structuredContent.resolved.fullHash).toBe(FULL);
		// signed rides along — never suppressed, consumers decide.
		expect(result.structuredContent.signed).toBe(false);
		expect(result.structuredContent.all.farcaster).toContain("farcaster.xyz/zoo");
	});

	test("fid + shorthash → username via /u, then /wc (form C)", async () => {
		mockShim({
			"/u/10215": { success: true, username: "zoo" },
			"/wc/zoo/0x895ecc74": {
				success: true,
				cast: { fid: FID, hash: FULL },
			},
			"/signed/10215": { success: true, signed: true },
		});
		const json = await callRpc("tools/call", {
			name: "get_cast_link",
			arguments: { fid: FID, shorthash: SHORT, client: "vibeshift" },
		});
		const result = json.result as { structuredContent: { url: string } };
		expect(result.structuredContent.url).toBe(
			`https://vibeshift.onchain.cooking/?view=cast&castHash=${FULL}&castFid=${FID}`,
		);
	});

	test("quilcast target emits bare hex; bare-hex shorthash input accepted", async () => {
		mockShim({
			"/wc/zoo/0x895ecc74": {
				success: true,
				cast: { fid: FID, hash: FULL },
			},
			"/signed/10215": { success: true, signed: true },
		});
		// shorthash WITHOUT 0x — normalized internally before the shim call.
		const json = await callRpc("tools/call", {
			name: "get_cast_link",
			arguments: { username: "zoo", shorthash: "895ecc74", client: "quilcast" },
		});
		const result = json.result as {
			structuredContent: { url: string; resolved: { hash: string } };
		};
		// quilcast's internal lookups key on bare lowercase hex — no 0x out.
		expect(result.structuredContent.url).toBe(
			`https://quilcast.com/c/${FULL.slice(2)}`,
		);
		expect(result.structuredContent.resolved.hash).toBe("0x895ecc74");
	});

	test("invalid reference (both hashes) → isError with the recovery hint", async () => {
		const json = await callRpc("tools/call", {
			name: "get_cast_link",
			arguments: { longhash: FULL, shorthash: SHORT, client: "all" },
		});
		const result = json.result as {
			isError: boolean;
			content: Array<{ text: string }>;
		};
		// SDK v2 surfaces schema validation as an isError result (not a
		// protocol error) — the superRefine message IS the recovery prompt.
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(
			"Send longhash or shorthash, not both",
		);
	});

	test("shim miss → isError with cast_not_found", async () => {
		mockShim({
			"/wc/zoo/0x895ecc74": { success: false },
		});
		const json = await callRpc("tools/call", {
			name: "get_cast_link",
			arguments: { username: "zoo", shorthash: SHORT, client: "all" },
		});
		const result = json.result as { isError: boolean; content: Array<{ text: string }> };
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("cast_not_found");
	});

	test("shim unreachable → isError with shim_unreachable", async () => {
		globalThis.fetch = mock(async () => {
			throw new Error("connection refused");
		});
		const json = await callRpc("tools/call", {
			name: "get_cast_link",
			arguments: { username: "zoo", shorthash: SHORT, client: "all" },
		});
		const result = json.result as { isError: boolean; content: Array<{ text: string }> };
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("shim_unreachable");
	});

	test("fid-gated client without fid → isError with client_unavailable", async () => {
		mockShim({
			"/wc/zoo/0x895ecc74": {
				success: true,
				cast: { hash: FULL, user: { username: "zoo" } }, // no fid
			},
		});
		const json = await callRpc("tools/call", {
			name: "get_cast_link",
			arguments: { username: "zoo", shorthash: SHORT, client: "vibeshift" },
		});
		const result = json.result as { isError: boolean; content: Array<{ text: string }> };
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("client_unavailable");
	});
});

// The external-link gate, MCP side: `requiresExternalLinks` clients
// answer `client_ineligible` when the resolved cast carries no external
// URL embed, and are omitted from the `all` record. Same predicate as
// the pill row (blockedByLinkGate), same fail-closed posture. The
// zod `client` enum is frozen at import, so these drive runGetCastLink
// directly with a fixture client pushed into CLIENTS (popped in
// finally — the roster guards run against the pristine registry).
describe("external-link gate (MCP)", () => {
	const GATED: ClientDefinition = {
		id: "gate-links",
		title: "GateLinks",
		logoUrl: "/logos/farcaster.svg",
		web: "https://links.test/c/{fullHashRaw}",
		requiresExternalLinks: true,
	};
	const signal = AbortSignal.timeout(5000);

	/** Resolves one shim-mocked cast shape against one target client. */
	async function outcomeFor(
		embeds: ShimEmbed[] | undefined,
		client: "gate-links" | "all",
	): Promise<ToolOutcome> {
		CLIENTS.push(GATED);
		try {
			mockShim({
				"/wc/zoo/0x895ecc74": {
					success: true,
					cast: {
						fid: FID,
						hash: FULL,
						user: { fid: FID, username: "zoo" },
						embeds,
					},
				},
				"/signed/10215": { success: true, signed: true },
			});
			// await INSIDE the try: the pop must wait for the (multi-hop,
			// async) resolution — an early return would empty the registry
			// while buildAll is still pending.
			return await runGetCastLink(
				{ username: "zoo", shorthash: SHORT, client },
				signal,
			);
		} finally {
			CLIENTS.pop();
		}
	}

	test("link-less cast → gated client answers client_ineligible", async () => {
		const outcome = await outcomeFor(undefined, "gate-links");
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.code).toBe("client_ineligible");
	});

	test("internal-only embeds do not qualify", async () => {
		const outcome = await outcomeFor(
			[{ url: `https://farcaster.xyz/zoo/${SHORT}` }],
			"gate-links",
		);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.code).toBe("client_ineligible");
	});

	test("external URL embed → gated client served, present in all", async () => {
		const outcome = await outcomeFor(
			[{ url: "https://example.com/article" }],
			"gate-links",
		);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			// {fullHashRaw}: bare lowercase hex, quilcast-style.
			const url = `https://links.test/c/${FULL.slice(2)}`;
			expect(outcome.result.url).toBe(url);
			expect(outcome.result.all["gate-links"]).toBe(url);
		}
	});

	test('"all" omits the gated client on a link-less cast; roster unaffected', async () => {
		const outcome = await outcomeFor(undefined, "all");
		expect(outcome.ok).toBe(true);
		if (outcome.ok) {
			expect(outcome.result.all["gate-links"]).toBeUndefined();
			expect(outcome.result.all.farcaster).toBeDefined();
		}
	});
});
