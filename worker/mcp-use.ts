// Yes/no counter for /mcp. One Analytics Engine row per request, nothing
// else: index `yes` only when the body is a get_cast_link tools/call AND
// the User-Agent did not name itself as automation. The UA string is
// classified and discarded — never stored. No cast ids, usernames, IPs,
// or arguments. Declared on /transparency.
//
// A `yes` is "something that did not self-identify invoked the tool."
// Named liveness checks and directory crawlers stay `no` even if they
// call the tool. A client whose UA is just `node` counts as `yes` when
// it actually calls — that distinction is the one HTTP logs cannot make.

import type { Context } from "hono";

/** Index values. Query `MCP_USE` grouped by index1. */
export const MCP_USE_YES = "yes";
export const MCP_USE_NO = "no";

/**
 * blob1, closed set. `call` is the only kind that indexes as yes.
 * `bot-call` is a tool invocation from a self-identified checker.
 * `card` / `sse` are the two GET shapes. Everything else is `other`
 * (initialize, tools/list, junk).
 */
export const MCP_USE_KINDS = [
	"call",
	"bot-call",
	"card",
	"sse",
	"other",
] as const;
export type McpUseKind = (typeof MCP_USE_KINDS)[number];

export interface McpUse {
	use: typeof MCP_USE_YES | typeof MCP_USE_NO;
	kind: McpUseKind;
}

/** Request bodies above this are classified from the prefix only. */
export const MCP_BODY_PREFIX = 4096;

// Substring match, case-insensitive, so "HostedMCPBot" and "prober" hit.
// Deliberately small: language HTTP libraries (`node`, `python-requests`,
// `Go-http-client`) are NOT in here — a tool call from those is the
// signal this counter exists to surface.
const AUTOMATION =
	/bot|crawler|spider|probe|scan|index(?:er)?|liveness|uptime|collector/i;

export function uaIsAutomation(userAgent: string): boolean {
	return AUTOMATION.test(userAgent);
}

function isGetCastLinkCall(message: unknown): boolean {
	if (message === null || typeof message !== "object") return false;
	const msg = message as Record<string, unknown>;
	if (msg.method !== "tools/call") return false;
	const params = msg.params;
	if (params === null || typeof params !== "object") return false;
	return (params as Record<string, unknown>).name === "get_cast_link";
}

/** True when the JSON-RPC body (object or batch) invokes get_cast_link. */
export function bodyInvokesGetCastLink(body: string): boolean {
	if (body === "") return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		// A cut-off prefix is not a call. False no, never a false yes.
		return false;
	}
	const messages = Array.isArray(parsed) ? parsed : [parsed];
	return messages.some(isGetCastLinkCall);
}

export function classifyMcpUse(facts: {
	method: string;
	accept: string;
	userAgent: string;
	body: string;
}): McpUse {
	if (facts.method === "GET") {
		const sse = facts.accept.includes("text/event-stream");
		return sse
			? { use: MCP_USE_NO, kind: "sse" }
			: { use: MCP_USE_NO, kind: "card" };
	}
	if (!bodyInvokesGetCastLink(facts.body)) {
		return { use: MCP_USE_NO, kind: "other" };
	}
	if (uaIsAutomation(facts.userAgent)) {
		return { use: MCP_USE_NO, kind: "bot-call" };
	}
	return { use: MCP_USE_YES, kind: "call" };
}

/** First `max` bytes of the body. Cancels the rest. Structural so the
 * Workers Request and the DOM Request both pass (their branded types
 * don't). */
export async function readBodyPrefix(
	req: { body?: ReadableStream<Uint8Array> | null },
	max = MCP_BODY_PREFIX,
): Promise<string> {
	const reader = req.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let n = 0;
	try {
		while (n < max) {
			const { done, value } = await reader.read();
			if (done || !value) break;
			chunks.push(value);
			n += value.byteLength;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const buf = new Uint8Array(Math.min(n, max));
	let offset = 0;
	for (const chunk of chunks) {
		const take = Math.min(chunk.byteLength, buf.length - offset);
		if (take <= 0) break;
		buf.set(chunk.subarray(0, take), offset);
		offset += take;
	}
	return new TextDecoder().decode(buf);
}

export function writeMcpUse(
	dataset: AnalyticsEngineDataset,
	cls: McpUse,
	host: string,
): void {
	dataset.writeDataPoint({
		indexes: [cls.use],
		blobs: [cls.kind, host],
	});
}

/**
 * Best-effort write. Missing binding or executionCtx skips it; the
 * response is never affected. `body` is already capped by the caller.
 */
export function noteMcpUse(
	c: Context<{ Bindings: Env }>,
	method: string,
	body: string | Promise<string>,
): void {
	try {
		const dataset = c.env?.MCP_USE;
		if (!dataset) return;
		const host = new URL(c.req.url).hostname;
		const facts = {
			method,
			accept: c.req.header("Accept") ?? "",
			userAgent: c.req.header("User-Agent") ?? "",
		};
		c.executionCtx.waitUntil(
			Promise.resolve(body)
				.then((text) => {
					writeMcpUse(dataset, classifyMcpUse({ ...facts, body: text }), host);
				})
				.catch(() => {}),
		);
	} catch {
		// No executionCtx (tests) — telemetry is best-effort.
	}
}

declare global {
	interface Env {
		MCP_USE: AnalyticsEngineDataset;
	}
}
