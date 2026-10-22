// Shim identity client — the one place that knows shim's routes, shapes,
// and base URL. Zero dependencies; consumers (the provider race, the quote
// hydrator, the signed check — and standalone builds like the MCP server)
// vendor or import this file.
//
// Identity resolution is shim-direct: shim is the canonical identity source
// (same trust position as the ban signal). These wrappers preserve each
// call site's exact failure semantics — see the per-function notes.

/** Base URL of the owner-run Snapchain reader. */
export const SHIM_BASE = "https://shim.artlu.xyz";

export const wcUrl = (username: string, hash: string): string =>
	`${SHIM_BASE}/wc/${username}/${hash}`;
export const hUrl = (hash: string): string => `${SHIM_BASE}/h/${hash}`;
export const fUrl = (username: string): string => `${SHIM_BASE}/f/${username}`;
export const uUrl = (fid: number): string => `${SHIM_BASE}/u/${fid}`;
export const signedUrl = (fid: number): string => `${SHIM_BASE}/signed/${fid}`;

export type ShimEmbed = { url?: string; castId?: { fid?: number; hash?: string } };

/** Canonical cast shape as returned by shim (unix-SECONDS timestamp). */
export type ShimCast = {
	fid?: number;
	hash?: string;
	text?: string;
	/** Unix seconds; the embed does new Date(ts), which wants milliseconds. */
	timestamp?: number;
	embeds?: ShimEmbed[];
	user?: {
		fid?: number;
		username?: string;
		displayName?: string;
		pfpUrl?: string;
		bio?: string;
	};
};

/** A returned cast is only valid if it resolves the hash that was asked for. */
export function resolvesHash(
	castHash: string | undefined,
	requested: string,
): boolean {
	return (
		typeof castHash === "string" &&
		castHash.toLowerCase().startsWith(requested.toLowerCase())
	);
}

export type ShimLookup =
	| { status: "found"; cast: ShimCast & { hash: string } }
	| { status: "miss" }
	| { status: "error"; message: string };

/**
 * GET /wc/{username}/{hash} — a miss is `{"success":false}` or an empty
 * body, both HTTP 200; a non-2xx or a thrown request is an error carrying
 * the same message text the provider race has always produced.
 */
export async function getCastByUsernameHash(
	username: string,
	hash: string,
	signal: AbortSignal,
): Promise<ShimLookup> {
	try {
		const res = await fetch(wcUrl(username, hash), { signal });
		if (!res.ok) {
			return { status: "error", message: `HTTP ${res.status}` };
		}
		const data = (await res.json().catch(() => undefined)) as
			| { success?: boolean; cast?: ShimCast }
			| undefined;
		const cast = data?.cast;
		if (data?.success === false || !cast?.hash) {
			return { status: "miss" };
		}
		return { status: "found", cast: { ...cast, hash: cast.hash } };
	} catch (error) {
		return { status: "error", message: String(error) };
	}
}

/**
 * GET /h/{hash} — cast by hash alone. Undefined on any failure (not-found,
 * non-2xx, parse, thrown): callers treat undefined as "drop it".
 */
export async function getCastByHash(
	hash: string,
	signal: AbortSignal,
): Promise<ShimCast | undefined> {
	try {
		const res = await fetch(hUrl(hash), { signal });
		if (!res.ok) return undefined;
		const data = (await res.json().catch(() => undefined)) as {
			cast?: ShimCast;
		};
		return data?.cast ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * GET /f/{username} — username → fid. Undefined when missing or malformed.
 * Network rejections propagate to the caller (same as before extraction).
 */
export async function getFidByUsername(
	username: string,
	signal: AbortSignal,
): Promise<number | undefined> {
	const res = await fetch(fUrl(username), { signal });
	if (!res.ok) return undefined;
	const data = (await res.json().catch(() => undefined)) as
		| { success?: boolean; fid?: number }
		| undefined;
	const fid = data?.fid;
	return typeof fid === "number" ? fid : undefined;
}

/**
 * GET /u/{fid} — fid → username. null when shim doesn't know the fid or
 * the answer is malformed. Network rejections propagate to the caller.
 */
export async function getUsernameByFid(
	fid: number,
	signal: AbortSignal,
): Promise<string | null> {
	const res = await fetch(uUrl(fid), { signal });
	if (!res.ok) return null;
	const data = (await res.json().catch(() => undefined)) as
		| { success?: boolean; username?: string }
		| undefined;
	const username = data?.username;
	return typeof username === "string" && username !== "" ? username : null;
}

/**
 * GET /signed/{fid} — has the fid signed the social smart contract?
 * null = unknown (non-2xx, malformed, thrown): callers fail open.
 */
export async function getSignedStatus(
	fid: number,
	signal: AbortSignal,
): Promise<boolean | null> {
	try {
		const res = await fetch(signedUrl(fid), { signal });
		if (res.ok) {
			const data = (await res.json().catch(() => ({}))) as {
				signed?: boolean;
			};
			if (typeof data.signed === "boolean") return data.signed;
		}
	} catch {
		// Signed-check unavailable — fail open.
	}
	return null;
}
