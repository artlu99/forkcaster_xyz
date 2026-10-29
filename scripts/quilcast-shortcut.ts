// Generates the quilcast → share-sheet shortcut.
//
// Run: bun run shortcut:quilcast
// Writes shortcuts/quilcast-router.shortcut (unsigned). A Mac signed into
// iCloud has to sign it before Shortcuts will import it — see the log line.

import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
	type Action,
	type DictionaryValue,
	Shortcut,
	type TokenString,
	actions,
	ref,
	shortcutInput,
	text,
	variable,
} from "shortcutkit";

const TARGETS = ["forkcaster", "farcaster", "firefly", "quorum"] as const;

const QUORUM_MISS =
	"Quorum needs the author's fid and resolution failed — opening Forkcaster instead.";

/** Editor toggle, stored on the action. A failed lookup then falls through. */
function allowFailure(action: Action) {
	action.WFWorkflowActionParameters.WFContinueOnError = true;
}

function setVar(s: Shortcut, name: string, source: Action) {
	s.action(actions.setvariable, {
		WFInput: ref(source),
		WFVariableName: name,
	});
}

function open(s: Shortcut, ...parts: Array<string | ReturnType<typeof variable>>) {
	s.action(actions.openurl, { WFInput: text(...parts) });
}

type DictNode =
	| string
	| number
	| boolean
	| TokenString
	| { WFSerializationType: "WFTextTokenAttachment"; Value: Record<string, unknown> }
	| { [key: string]: DictNode };

function isTokenString(v: unknown): v is TokenString {
	return (
		typeof v === "object" &&
		v !== null &&
		"WFSerializationType" in v &&
		v.WFSerializationType === "WFTextTokenString"
	);
}

function isAttachment(
	v: unknown,
): v is { WFSerializationType: "WFTextTokenAttachment"; Value: Record<string, unknown> } {
	return (
		typeof v === "object" &&
		v !== null &&
		"WFSerializationType" in v &&
		v.WFSerializationType === "WFTextTokenAttachment"
	);
}

function isDict(v: unknown): v is { [key: string]: DictNode } {
	return (
		typeof v === "object" &&
		v !== null &&
		!Array.isArray(v) &&
		!("WFSerializationType" in v)
	);
}

/**
 * Dictionary parameters (headers, JSON body) use the engine's field-value
 * form. Nested dictionaries are wrapped once more than the outer one — that
 * is the shape Shortcuts writes and reads back.
 */
function dictionary(items: { [key: string]: DictNode }): DictionaryValue {
	return {
		WFSerializationType: "WFDictionaryFieldValue",
		Value: {
			WFDictionaryFieldValueItems: Object.entries(items).map(([key, value]) => ({
				WFKey: text(key),
				...dictionaryItem(value),
			})),
		},
	} as DictionaryValue;
}

function dictionaryItem(value: DictNode): { WFItemType: number; WFValue: unknown } {
	if (typeof value === "string" || isTokenString(value)) {
		return { WFItemType: 0, WFValue: typeof value === "string" ? text(value) : value };
	}
	if (isAttachment(value)) return { WFItemType: 0, WFValue: text(value) };
	if (typeof value === "number") return { WFItemType: 3, WFValue: text(String(value)) };
	if (typeof value === "boolean") {
		return {
			WFItemType: 4,
			WFValue: { WFSerializationType: "WFNumberSubstitutableState", Value: value },
		};
	}
	if (isDict(value)) {
		return {
			WFItemType: 1,
			WFValue: {
				WFSerializationType: "WFDictionaryFieldValue",
				Value: dictionary(value),
			},
		};
	}
	throw new Error(`dictionary value not serializable: ${JSON.stringify(value)}`);
}

function dictKey(s: Shortcut, source: Action, key: string): Action {
	const got = s.action(actions.getvalueforkey, {
		WFInput: ref(source),
		WFGetDictionaryValueType: "Value",
		WFDictionaryKey: key,
	});
	allowFailure(got);
	return got;
}

/** Share-sheet shortcut: quilcast link in, one client link out. */
export function buildQuilcastRouter(): Shortcut {
	const s = new Shortcut("quilcast →", {
		types: ["ActionExtension"],
		inputClasses: ["WFURLContentItem", "WFSafariWebPageContentItem"],
	});

	const urls = s.action(actions.detect_link, { WFInput: shortcutInput() });
	const urlText = s.action(actions.gettext, { WFTextActionText: ref(urls) });
	const raw = s.action(actions.gettext, { WFTextActionText: shortcutInput() });

	// Prefer the extracted URL. A CLI run ("firefly https://…") still has the
	// quilcast URL in the raw text when Get URLs finds nothing useful.
	const sourceIf = s.if(ref(urlText), "contains", "quilcast.com");
	setVar(s, "Source", urlText);
	s.otherwise(sourceIf);
	setVar(s, "Source", raw);
	s.endIf(sourceIf);

	const castIf = s.if(variable("Source"), "contains", "/c/");
	const hashMatch = s.action(actions.text_match, {
		text: variable("Source"),
		WFMatchTextPattern: "[0-9a-fA-F]{40}",
		WFMatchTextCaseSensitive: false,
	});
	const hashText = s.action(actions.gettext, {
		WFTextActionText: text("0x", ref(hashMatch)),
	});
	setVar(s, "Hash", hashText);
	setVar(s, "Kind", s.action(actions.gettext, { WFTextActionText: "cast" }));
	s.otherwise(castIf);

	const profileIf = s.if(variable("Source"), "contains", "/u/");
	const userMatch = s.action(actions.text_match, {
		text: variable("Source"),
		WFMatchTextPattern: "/u/([A-Za-z0-9._-]{1,20})",
		WFMatchTextCaseSensitive: false,
	});
	const userGroup = s.action(actions.text_match_getgroup, {
		matches: ref(userMatch),
		WFGetGroupType: "Group At Index",
		WFGroupIndex: 1,
	});
	setVar(s, "Username", userGroup);
	setVar(s, "Kind", s.action(actions.gettext, { WFTextActionText: "profile" }));
	s.otherwise(profileIf);
	s.action(actions.notification, {
		WFNotificationActionTitle: "quilcast →",
		WFNotificationActionBody: "Not a quilcast link",
	});
	s.action(actions.exit, {});
	s.endIf(profileIf);
	s.endIf(castIf);

	const word = s.action(actions.text_match, {
		text: ref(raw),
		WFMatchTextPattern: "(?i)^(forkcaster|farcaster|firefly|quorum)\\b",
		WFMatchTextCaseSensitive: false,
	});
	const wordIf = s.if(ref(word), "has_any_value");
	const lower = s.action(actions.text_changecase, {
		text: ref(word),
		WFCaseType: "lowercase",
	});
	setVar(s, "Target", lower);
	s.otherwise(wordIf);
	const menu = s.chooseFromMenu("Open in…", [...TARGETS]);
	for (const name of TARGETS) {
		s.menuItem(menu, name);
		setVar(s, "Target", s.action(actions.gettext, { WFTextActionText: name }));
	}
	s.endMenu(menu);
	s.endIf(wordIf);

	const quorumIf = s.if(variable("Target"), "is", "quorum");
	const quorumCast = s.if(variable("Kind"), "is", "cast");
	const post = s.action(actions.downloadurl, {
		WFURL: "https://forkcaster.xyz/mcp",
		WFHTTPMethod: "POST",
		// Boolean, not 1: the header fields are gated on ShowHeaders being true.
		ShowHeaders: true as unknown as number,
		WFHTTPHeaders: dictionary({
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		}),
		WFHTTPBodyType: "JSON",
		WFJSONValues: dictionary({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "get_cast_link",
				arguments: { longhash: variable("Hash"), client: "all" },
			},
		}),
	});
	allowFailure(post);
	const sse = s.action(actions.text_match, {
		text: ref(post),
		WFMatchTextPattern: "data: (.*)",
		WFMatchTextCaseSensitive: false,
	});
	allowFailure(sse);
	const sseGroup = s.action(actions.text_match_getgroup, {
		matches: ref(sse),
		WFGetGroupType: "Group At Index",
		WFGroupIndex: 1,
	});
	allowFailure(sseGroup);
	const rpc = s.action(actions.detect_dictionary, { WFInput: ref(sseGroup) });
	allowFailure(rpc);
	const result = dictKey(s, rpc, "result");
	const structured = dictKey(s, result, "structuredContent");
	const resolved = dictKey(s, structured, "resolved");
	setVar(s, "RUser", dictKey(s, resolved, "username"));
	setVar(s, "RFid", dictKey(s, resolved, "fid"));
	s.otherwise(quorumCast);
	const profileUrl = s.action(actions.downloadurl, {
		WFURL: text("https://forkcaster.xyz/", variable("Username"), "?format=json"),
		WFHTTPMethod: "GET",
	});
	allowFailure(profileUrl);
	const profileDict = s.action(actions.detect_dictionary, {
		WFInput: ref(profileUrl),
	});
	allowFailure(profileDict);
	setVar(s, "RFid", dictKey(s, profileDict, "fid"));
	s.endIf(quorumCast);
	s.endIf(quorumIf);

	const openCast = s.if(variable("Kind"), "is", "cast");
	const forkCast = s.if(variable("Target"), "is", "forkcaster");
	open(s, "https://forkcaster.xyz/~/conversations/", variable("Hash"));
	s.otherwise(forkCast);
	const farCast = s.if(variable("Target"), "is", "farcaster");
	open(s, "https://farcaster.xyz/~/conversations/", variable("Hash"));
	s.otherwise(farCast);
	const flyCast = s.if(variable("Target"), "is", "firefly");
	open(s, "https://firefly.social/post/farcaster/", variable("Hash"));
	s.otherwise(flyCast);
	const named = s.if(variable("RUser"), "has_any_value");
	open(
		s,
		"quorummobile://feed?castHashPrefix=",
		variable("Hash"),
		"&username=",
		variable("RUser"),
	);
	s.otherwise(named);
	open(s, "quorummobile://feed?castHashPrefix=", variable("Hash"));
	s.endIf(named);
	s.endIf(flyCast);
	s.endIf(farCast);
	s.endIf(forkCast);
	s.otherwise(openCast);

	const forkProfile = s.if(variable("Target"), "is", "forkcaster");
	open(s, "https://forkcaster.xyz/", variable("Username"));
	s.otherwise(forkProfile);
	const farProfile = s.if(variable("Target"), "is", "farcaster");
	open(s, "https://farcaster.xyz/", variable("Username"));
	s.otherwise(farProfile);
	const flyProfile = s.if(variable("Target"), "is", "firefly");
	open(s, "https://firefly.social/profile/farcaster/", variable("Username"));
	s.otherwise(flyProfile);
	const haveFid = s.if(variable("RFid"), "has_any_value");
	open(
		s,
		"quorummobile://feed?profileFid=",
		variable("RFid"),
		"&profileUsername=",
		variable("Username"),
	);
	s.otherwise(haveFid);
	s.action(actions.alert, {
		WFAlertActionTitle: "quilcast →",
		WFAlertActionMessage: QUORUM_MISS,
		WFAlertActionCancelButtonShown: false,
	});
	open(s, "https://forkcaster.xyz/", variable("Username"));
	s.endIf(haveFid);
	s.endIf(flyProfile);
	s.endIf(farProfile);
	s.endIf(forkProfile);
	s.endIf(openCast);

	return s;
}

const OUT = new URL("../shortcuts/quilcast-router.shortcut", import.meta.url);

if (import.meta.main) {
	const shortcut = buildQuilcastRouter();
	await mkdir(dirname(OUT.pathname), { recursive: true });
	const written = await shortcut.write(OUT.pathname);
	// shortcuts sign is happier with a binary plist. plutil is macOS-only;
	// Python's plistlib writes the same container.
	const converted = spawnSync(
		"python3",
		[
			"-c",
			"import plistlib, pathlib, sys; p = pathlib.Path(sys.argv[1]); p.write_bytes(plistlib.dumps(plistlib.loads(p.read_bytes()), fmt=plistlib.FMT_BINARY))",
			written,
		],
		{ encoding: "utf8" },
	);
	if (converted.status !== 0) {
		throw new Error(converted.stderr || "could not write a binary plist");
	}
	console.log(written);
	console.log(
		'On a Mac: shortcuts sign --mode anyone --input shortcuts/quilcast-router.shortcut --output "$HOME/Desktop/quilcast →.shortcut" && open "$HOME/Desktop/quilcast →.shortcut"',
	);
}
