/**
 * MCP use counter: yes only for a get_cast_link tools/call whose
 * User-Agent did not self-identify as automation. The row never carries
 * the UA, the cast, or the arguments.
 */
import { describe, expect, test } from "bun:test";

import {
	bodyInvokesGetCastLink,
	classifyMcpUse,
	MCP_BODY_PREFIX,
	readBodyPrefix,
	uaIsAutomation,
} from "./mcp-use.ts";

const CALL = JSON.stringify({
	jsonrpc: "2.0",
	id: 1,
	method: "tools/call",
	params: {
		name: "get_cast_link",
		arguments: { username: "zoo", shorthash: "0x895ecc74" },
	},
});

describe("uaIsAutomation", () => {
	test("named checkers match; bare HTTP libraries do not", () => {
		expect(uaIsAutomation("node")).toBe(false);
		expect(uaIsAutomation("")).toBe(false);
		expect(uaIsAutomation("python-requests/2.33.0")).toBe(false);
		expect(uaIsAutomation("Go-http-client/2.0")).toBe(false);
		expect(
			uaIsAutomation(
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
			),
		).toBe(false);
		expect(
			uaIsAutomation("mcpbeat/0.1 (+https://mcpbeat.com/bot/; liveness check)"),
		).toBe(true);
		expect(
			uaIsAutomation(
				"SentinelOracle/0.1 (+https://glimind.com/opt-out; liveness-only, never invokes tools)",
			),
		).toBe(true);
		expect(
			uaIsAutomation("HostedMCPBot/1.0 (+https://hostedmcp.org/bot)"),
		).toBe(true);
		expect(uaIsAutomation("ClaudeBot/1.0")).toBe(true);
		expect(uaIsAutomation("rokmcp-collector/0.2")).toBe(true);
	});
});

describe("classifyMcpUse", () => {
	test("a non-bot tools/call is yes, and the cast is not part of the class", () => {
		const cls = classifyMcpUse({
			method: "POST",
			accept: "application/json, text/event-stream",
			userAgent: "node",
			body: CALL,
		});
		expect(cls).toEqual({ use: "yes", kind: "call" });
		expect(JSON.stringify(cls)).not.toContain("zoo");
		expect(JSON.stringify(cls)).not.toContain("895ecc74");
	});

	test("the same call from a self-identified checker is no", () => {
		expect(
			classifyMcpUse({
				method: "POST",
				accept: "application/json",
				userAgent: "ToolVetProbe/1.0 (+https://toolvet.app/methodology)",
				body: CALL,
			}),
		).toEqual({ use: "no", kind: "bot-call" });
	});

	test("handshake, list, and a different tool are no", () => {
		for (const body of [
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {},
			}),
			JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "other", arguments: {} },
			}),
			"",
			"not json",
		]) {
			expect(
				classifyMcpUse({
					method: "POST",
					accept: "application/json",
					userAgent: "node",
					body,
				}).use,
			).toBe("no");
		}
	});

	test("a batch counts as a call when one message invokes the tool", () => {
		const body = JSON.stringify([
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			{
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "get_cast_link", arguments: { hash: "0xabc" } },
			},
		]);
		expect(bodyInvokesGetCastLink(body)).toBe(true);
		expect(
			classifyMcpUse({
				method: "POST",
				accept: "application/json",
				userAgent: "node",
				body,
			}).use,
		).toBe("yes");
	});

	test("GET is the card or the SSE probe, never a yes", () => {
		expect(
			classifyMcpUse({
				method: "GET",
				accept: "text/html",
				userAgent: "Mozilla/5.0",
				body: "",
			}),
		).toEqual({ use: "no", kind: "card" });
		expect(
			classifyMcpUse({
				method: "GET",
				accept: "text/event-stream",
				userAgent: "node",
				body: "",
			}),
		).toEqual({ use: "no", kind: "sse" });
	});

	test("a truncated prefix is not a yes", () => {
		const cut = CALL.slice(0, 40);
		expect(bodyInvokesGetCastLink(cut)).toBe(false);
	});
});

test("readBodyPrefix stops at the cap and still yields a parseable call", async () => {
	const req = new Request("https://forkcaster.xyz/mcp", {
		method: "POST",
		body: CALL,
	});
	const text = await readBodyPrefix(req, MCP_BODY_PREFIX);
	expect(text).toBe(CALL);
	expect(bodyInvokesGetCastLink(text)).toBe(true);
});
