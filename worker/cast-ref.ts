// Cast reference — the zod contract and resolution logic behind the MCP
// tool. Pure logic: no MCP SDK imports here, so protocol/SDK churn can
// never reach resolution — protocol churn stops at mcp.ts.
//
// Identity resolution is shim-direct (canonical identity source, same
// trust position as the ban signal): /h (longhash), /u + /wc (fid +
// shorthash), /wc (username + shorthash). A shim non-200 is a cache miss
// on shim's side and resolves to cast_not_found — the longhash form is
// the reliable one for fresh casts. Author signed-status rides along
// (shim /signed/{fid}); URLs are built for every reference regardless of
// signed state — the one exception being the cast-eligibility gate:
// requiresExternalLinks clients answer client_ineligible (and drop from
// `all`) when the resolved cast carries no external URL embed, the same
// blockedByLinkGate predicate the pill row uses.

import { z } from "zod";
import {
	CLIENTS,
	CLIENT_IDS,
	blockedByLinkGate,
	missingVars,
	resolveTemplate,
	type TemplateVars,
} from "./client-registry.ts";
import { hasExternalLinks } from "./cast-data.ts";
import {
	getCastByHash,
	getCastByUsernameHash,
	getSignedStatus,
	getUsernameByFid,
	resolvesHash,
	type ShimCast,
} from "./shim.ts";

const LONGHASH = /^(?:0x)?[0-9a-fA-F]{40}$/;
const SHORTHASH = /^(?:0x)?[0-9a-fA-F]{4,39}$/;
const USERNAME = /^[A-Za-z0-9._-]{1,30}$/;

/** Normalizes either hash form to 0x-prefixed lowercase before hitting shim. */
const with0x = (hash: string): string =>
	(/^0x/i.test(hash) ? hash : `0x${hash}`).toLowerCase();

const CLIENT_TARGETS = [...CLIENT_IDS, "all"] as const;

export const castRefInput = z
	.object({
		longhash: z
			.string()
			.regex(LONGHASH)
			.optional()
			.describe(
				"Full cast hash — 40 hex characters, with or without the 0x prefix. Identifies the cast on its own; the most reliable form for fresh casts.",
			),
		fid: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Author's Farcaster fid (numeric account id)."),
		username: z
			.string()
			.regex(USERNAME)
			.optional()
			.describe("Author's Farcaster username, without the @."),
		shorthash: z
			.string()
			.regex(SHORTHASH)
			.optional()
			.describe(
				"Abbreviated cast hash as it appears in share URLs — 4-39 hex characters, 0x prefix optional. Requires username or fid alongside it.",
			),
		client: z
			.enum(CLIENT_TARGETS)
			.describe(
				'Target Farcaster client app, or "all" to return every supported client\'s URL.',
			),
	})
	.superRefine((value, ctx) => {
		const hasLong = value.longhash !== undefined;
		const hasShort = value.shorthash !== undefined;
		if (hasLong && hasShort) {
			ctx.addIssue({
				code: "custom",
				message:
					"Send longhash or shorthash, not both — the longhash identifies the cast on its own.",
			});
			return;
		}
		if (!hasLong && !hasShort) {
			ctx.addIssue({
				code: "custom",
				message:
					"Identify the cast with longhash (full 40-hex hash) alone, or shorthash together with username or fid.",
			});
			return;
		}
		if (!hasLong && value.username === undefined && value.fid === undefined) {
			ctx.addIssue({
				code: "custom",
				message:
					"A shorthash needs company: add username or fid alongside it — or send the longhash alone.",
			});
		}
	});

export const castRefOutput = z.object({
	client: z.string(),
	url: z.string().nullable(),
	canonical: z.string(),
	forkcaster: z.string(),
	signed: z.boolean().nullable(),
	resolved: z.object({
		username: z.string(),
		fid: z.number().int().nullable(),
		fullHash: z.string(),
		hash: z.string(),
	}),
	all: z.record(z.string(), z.string()),
});

export type CastRefInput = z.infer<typeof castRefInput>;
export type CastRefOutput = z.infer<typeof castRefOutput>;

export type ToolErrorCode =
	| "cast_not_found"
	| "unresolvable"
	| "shim_unreachable"
	| "client_unknown"
	| "client_eol"
	| "client_suspended"
	| "client_unavailable"
	| "client_ineligible";

export type ToolOutcome =
	| { ok: true; result: CastRefOutput }
	| { ok: false; code: ToolErrorCode; message: string };

const err = (code: ToolErrorCode, message: string): ToolOutcome => ({
	ok: false,
	code,
	message,
});

/** forkcaster's own URL is host-branded by definition, hence the constant. */
const FORKCASTER_ORIGIN = "https://forkcaster.xyz";

type Identity = {
	username: string;
	fid: number | null;
	fullHash: string;
	/** The hash form as requested by the caller. */
	hash: string;
	/**
	 * Whether the resolved cast carries ≥1 external URL embed — the pill
	 * row's gate state, so requiresExternalLinks clients are gated
	 * identically here. MCP always resolves the cast: never unknown.
	 */
	hasExternalLinks: boolean;
};

class ShimUnavailableError extends Error {}

function identityFromCast(
	cast: ShimCast & { hash: string },
	requestedHash: string,
): Identity {
	const fid = cast.fid ?? cast.user?.fid ?? null;
	return {
		// Identity law: the author handle is the primary (fname first).
		username: cast.user?.fname ?? cast.user?.username ?? "",
		fid: typeof fid === "number" ? fid : null,
		fullHash: cast.hash,
		hash: requestedHash,
		hasExternalLinks: hasExternalLinks(cast),
	};
}

// --- form A: username + shorthash ---

async function resolveByUsernameHash(
	username: string,
	hash: string,
	signal: AbortSignal,
): Promise<Identity | null> {
	const lookup = await getCastByUsernameHash(username, hash, signal);
	if (lookup.status === "error") throw new ShimUnavailableError(lookup.message);
	if (lookup.status === "miss") return null;
	if (!resolvesHash(lookup.cast.hash, hash)) return null;
	const identity = identityFromCast(lookup.cast, hash);
	// Sparse cast data: the caller's username is as good as shim's.
	if (identity.username === "") return { ...identity, username };
	return identity;
}

// --- form B: longhash ---

async function resolveByLonghash(
	longhash: string,
	signal: AbortSignal,
): Promise<Identity | null> {
	const cast = await getCastByHash(longhash, signal);
	if (cast === undefined || !resolvesHash(cast.hash, longhash)) return null;
	const identity = identityFromCast(
		cast as ShimCast & { hash: string },
		longhash,
	);
	if (identity.username !== "") return identity;
	// Sparse author data: fall back to /u/{fid}.
	if (identity.fid === null) return null;
	const username = await getUsernameByFid(identity.fid, signal);
	if (username === null) return null;
	return { ...identity, username };
}

// --- form C: fid + shorthash ---

async function resolveByFid(
	fid: number,
	hash: string,
	signal: AbortSignal,
): Promise<Identity | null> {
	const username = await getUsernameByFid(fid, signal);
	if (username === null) return null;
	return resolveByUsernameHash(username, hash, signal);
}

// --- URLs ---

function buildVars(identity: Identity): TemplateVars {
	return {
		username: identity.username,
		hash: identity.hash,
		fullHash: identity.fullHash,
		fid: identity.fid ?? undefined,
	};
}

function buildAll(identity: Identity): Record<string, string> {
	const vars = buildVars(identity);
	const all: Record<string, string> = {};
	for (const client of CLIENTS) {
		if (client.status === "suspended" || client.status === "eol") continue;
		if (client.web === undefined) continue;
		if (blockedByLinkGate(client, identity.hasExternalLinks)) continue;
		if (missingVars(client.web, vars).length > 0) continue;
		all[client.id] = resolveTemplate(client.web, vars);
	}
	return all;
}

// --- tool entry ---

export async function runGetCastLink(
	input: CastRefInput,
	signal: AbortSignal,
): Promise<ToolOutcome> {
	const target = input.client;
	const targetClient =
		target === "all"
			? undefined
			: CLIENTS.find((entry) => entry.id === target);
	if (targetClient === undefined && target !== "all") {
		return err("client_unknown", `Unknown client "${target}".`);
	}
	if (targetClient?.status === "suspended") {
		return err(
			"client_suspended",
			`Client "${target}" is suspended and its URLs are not served.`,
		);
	}
	if (targetClient?.status === "eol") {
		return err(
			"client_eol",
			`Client "${target}" is no longer supported.`,
		);
	}

	let identity: Identity | null;
	try {
		if (input.longhash !== undefined) {
			identity = await resolveByLonghash(with0x(input.longhash), signal);
		} else if (input.fid !== undefined) {
			identity = await resolveByFid(
				input.fid,
				with0x(input.shorthash ?? ""),
				signal,
			);
		} else {
			identity = await resolveByUsernameHash(
				input.username ?? "",
				with0x(input.shorthash ?? ""),
				signal,
			);
		}
	} catch (error) {
		if (error instanceof ShimUnavailableError) {
			return err("shim_unreachable", error.message);
		}
		throw error;
	}
	if (identity === null) {
		return err(
			"cast_not_found",
			input.longhash !== undefined
				? "No cast found for this longhash. Fresh casts may not be indexed yet — retry shortly."
				: "No cast found for this reference. If you have the full 40-hex hash, sending it alone is the most reliable form.",
		);
	}

	const all = buildAll(identity);
	const canonical =
		all.farcaster ??
		`https://farcaster.xyz/${encodeURIComponent(identity.username)}/${encodeURIComponent(identity.fullHash)}`;
	const signed =
		identity.fid !== null
			? await getSignedStatus(identity.fid, signal)
			: null;

	if (target === "all") {
		return {
			ok: true,
			result: {
				client: "all",
				url: null,
				canonical,
				forkcaster: `${FORKCASTER_ORIGIN}/${encodeURIComponent(identity.username)}/${encodeURIComponent(identity.fullHash)}`,
				signed,
				resolved: {
					username: identity.username,
					fid: identity.fid,
					fullHash: identity.fullHash,
					hash: identity.hash,
				},
				all,
			},
		};
	}

	// Eligibility precedes reference sparsity: a links-only client on a
	// link-less cast is the business answer, even if vars are missing too.
	if (
		targetClient !== undefined &&
		blockedByLinkGate(targetClient, identity.hasExternalLinks)
	) {
		return err(
			"client_ineligible",
			`Client "${target}" only serves casts that share an external link, and this cast has none visible — try another client, or "all".`,
		);
	}

	const url = all[target];
	if (url === undefined) {
		return err(
			"client_unavailable",
			`No per-cast URL could be built for "${target}" from this reference — try another client, or a fuller reference that includes the author's fid.`,
		);
	}
	return {
		ok: true,
		result: {
			client: target,
			url,
			canonical,
			forkcaster: `${FORKCASTER_ORIGIN}/${encodeURIComponent(identity.username)}/${encodeURIComponent(identity.fullHash)}`,
			signed,
			resolved: {
				username: identity.username,
				fid: identity.fid,
				fullHash: identity.fullHash,
				hash: identity.hash,
			},
			all,
		},
	};
}
