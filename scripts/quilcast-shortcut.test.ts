import { expect, test } from "bun:test";
import { buildQuilcastRouter } from "./quilcast-shortcut.ts";

type Step = {
	WFWorkflowActionIdentifier: string;
	WFWorkflowActionParameters: Record<string, unknown>;
};

function steps(): Step[] {
	const plist = buildQuilcastRouter().toPlist();
	return plist.WFWorkflowActions as Step[];
}

test("share sheet accepts URLs and Safari pages", () => {
	const plist = buildQuilcastRouter().toPlist();
	expect(plist.WFWorkflowTypes).toEqual(["ActionExtension"]);
	expect(plist.WFWorkflowInputContentItemClasses).toEqual([
		"WFURLContentItem",
		"WFSafariWebPageContentItem",
	]);
});

test("every control-flow group opens and closes once", () => {
	const counts = new Map<string, number[]>();
	for (const step of steps()) {
		const gid = step.WFWorkflowActionParameters.GroupingIdentifier;
		const mode = step.WFWorkflowActionParameters.WFControlFlowMode;
		if (typeof gid !== "string" || typeof mode !== "number") continue;
		const row = counts.get(gid) ?? [0, 0, 0];
		row[mode] = (row[mode] ?? 0) + 1;
		counts.set(gid, row);
	}
	expect(counts.size).toBeGreaterThan(0);
	for (const [gid, row] of counts) {
		expect(row[0], gid).toBe(1);
		expect(row[2], gid).toBe(1);
	}
});

test("routes, menu, and the quorum resolve call are in the file", () => {
	const blob = JSON.stringify(buildQuilcastRouter().toPlist());
	for (const needle of [
		"quilcast.com",
		"[0-9a-fA-F]{40}",
		"/u/([A-Za-z0-9._-]{1,20})",
		"(?i)^(forkcaster|farcaster|firefly|quorum)",
		"Open in…",
		"Not a quilcast link",
		"https://forkcaster.xyz/~/conversations/",
		"https://farcaster.xyz/~/conversations/",
		"https://firefly.social/post/farcaster/",
		"https://firefly.social/profile/farcaster/",
		"quorummobile://feed?castHashPrefix=",
		"quorummobile://feed?profileFid=",
		"&username=",
		"&profileUsername=",
		"https://forkcaster.xyz/mcp",
		"?format=json",
		"structuredContent",
		"Quorum needs the author's fid and resolution failed — opening Forkcaster instead.",
	]) {
		expect(blob, needle).toContain(needle);
	}
	for (const target of ["forkcaster", "farcaster", "firefly", "quorum"]) {
		expect(blob).toContain(`"WFMenuItemTitle":"${target}"`);
	}
});

test("cast resolve posts the hash variable to the MCP tool", () => {
	const post = steps().find(
		(step) =>
			step.WFWorkflowActionIdentifier === "is.workflow.actions.downloadurl" &&
			step.WFWorkflowActionParameters.WFHTTPMethod === "POST",
	);
	expect(post?.WFWorkflowActionParameters.WFContinueOnError).toBe(true);
	const blob = JSON.stringify(post?.WFWorkflowActionParameters.WFJSONValues);
	expect(blob).toContain("get_cast_link");
	expect(blob).toContain('"VariableName":"Hash"');
	expect(blob).toContain('"string":"client"');
	expect(blob).toContain('"string":"all"');
});
