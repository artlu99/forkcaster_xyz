// Shim identity client — the one place that knows shim's routes, shapes,
// and base URL. Zero dependencies; consumers (the provider race, the quote
// hydrator, the signed check — and standalone builds like the MCP server)
// vendor or import this file.
//
// Identity resolution is shim-direct: shim is the canonical identity source
// (same trust position as the ban signal). These wrappers preserve each
// call site's exact failure semantics — see the per-function notes.

/** Base URL of the owner-run Snapchain reader. */
export const SHIM_CLOUD_BASE = "https://shim.artlu.xyz";

/**
 * One shim leg's terminal state — the raced wrappers below speak in these.
 * `found` is an affirmative answer any source may produce; `miss` carries
 * `fallback`, the CLOUD-shaped answer for that exact response, so the
 * wrapper replays today's per-endpoint verdict byte-for-byte when cloud is
 * the terminal leg (sparse users, ok:false timelines, null handles…);
 * `error` carries the thrown value cloud's contract propagates (outage
 * signals) plus the never-throw fallback for fail-soft endpoints.
 */
export type ShimProbe<T> =
	| { kind: "found"; value: T }
	| { kind: "miss"; fallback: T | undefined }
	| { kind: "error"; error: unknown; fallback: T | undefined };

/**
 * Race cloud against the shim-potato fleet (`potatoBasess` — the raw var
 * value, one or more comma-separated base URLs) under the caller's
 * AbortSignal. Fleet semantics — no single host is the source of truth:
 *
 * - the FIRST affirmative (found) answer wins outright;
 * - a consulted miss (HTTP 200, index asked, no data) is a VOTE, not a
 *   verdict: not-found settles only when every leg has missed. A pending
 *   leg can still rescue a miss that already landed;
 * - errors (non-2xx/timeout — outage signals) never decide anything:
 *   they surface (cloud's, for legacy message stability) only when every
 *   leg errored;
 * - latency of a true miss = the slowest leg's miss (bounded by the
 *   caller's signal) — the deliberate price of softening the SPOF.
 *
 * Without `potatoBasess` this is a pass-through — identical fetches, zero
 * overhead (which is what keeps every test and caller honest).
 */
export async function raceShimProbe<T>(
	probe: (base: string) => Promise<ShimProbe<T>>,
	potatoBasess?: string | null,
): Promise<ShimProbe<T>> {
	const bases = fleetBases(potatoBasess);
	if (bases.length === 0) return probe(SHIM_CLOUD_BASE);
	return new Promise<ShimProbe<T>>((resolve) => {
		let unsettled = bases.length + 1;
		let done = false;
		let cloudTerminal: ShimProbe<T> | undefined;
		let firstMissFallback: T | undefined;
		let sawMiss = false;
		const settle = (r: ShimProbe<T>) => {
			if (!done) {
				done = true;
				resolve(r);
			}
		};
		const onTerminal = (index: number, r: ShimProbe<T>) => {
			if (done) return;
			if (r.kind === "found") return settle(r);
			if (index === 0) cloudTerminal = r;
			if (r.kind === "miss") {
				sawMiss = true;
				if (firstMissFallback === undefined) firstMissFallback = r.fallback;
			}
			unsettled -= 1;
			if (unsettled === 0) {
				// Collective verdict — the fleet decided, not one host.
				if (sawMiss) {
					// A consulted miss beats errors: the network was asked.
					// Cloud's fallback replays when cloud is the missing leg
					// (byte-compat with the pre-fleet all-miss answers).
					const fallback =
						cloudTerminal?.kind === "miss"
							? cloudTerminal.fallback
							: firstMissFallback;
					settle({ kind: "miss", fallback });
				} else if (cloudTerminal !== undefined) {
					settle(cloudTerminal);
				} else {
					settle({ kind: "miss", fallback: undefined });
				}
			}
		};
		[SHIM_CLOUD_BASE, ...bases].forEach((base, index) => {
			// Probes catch their own transport failures, so the rejection
			// arm is purely defensive — an errored leg is still a terminal.
			probe(base).then(
				(r) => onTerminal(index, r),
				(error) =>
					onTerminal(index, { kind: "error", error, fallback: undefined }),
			);
		});
	});
}

/**
 * Parse the canary fleet list: comma-separated base URLs, trimmed,
 * trailing slashes stripped, deduped, cloud itself dropped. The
 * SHIM_POTATO_BASE var carries one base today and the comma-separated
 * fleet as the regional potatos come online.
 */
export function fleetBases(potatoBasess?: string | null): string[] {
	const out: string[] = [];
	for (const raw of (potatoBasess ?? "").split(",")) {
		const base = raw.trim().replace(/\/+$/, "");
		if (base === "" || base === SHIM_CLOUD_BASE || out.includes(base)) continue;
		out.push(base);
	}
	return out;
}

export const wcUrl = (username: string, hash: string): string =>
	`${SHIM_CLOUD_BASE}/wc/${username}/${hash}`;
export const hUrl = (hash: string): string => `${SHIM_CLOUD_BASE}/h/${hash}`;
export const fUrl = (username: string): string => `${SHIM_CLOUD_BASE}/f/${username}`;
export const uUrl = (fid: number): string => `${SHIM_CLOUD_BASE}/u/${fid}`;
export const userUrl = (fid: number): string => `${SHIM_CLOUD_BASE}/user/${fid}`;
export const castsAndRepliesUrl = (username: string, limit: number): string =>
	`${SHIM_CLOUD_BASE}/${username}/casts-and-replies?limit=${limit}`;
export const signedUrl = (fid: number): string => `${SHIM_CLOUD_BASE}/signed/${fid}`;
export const refreshUrl = (): string => `${SHIM_CLOUD_BASE}/refresh`;

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
		/** The account's fname — the PRIMARY handle under the identity law. */
		fname?: string | null;
		/** Verified ENS names — attestations (carried, not rendered, on casts). */
		attestations?: string[] | null;
		displayName?: string;
		pfpUrl?: string;
		bio?: string;
	};
};

/**
 * Hydrated user entity as returned by shim /user/{fid}. Every field except
 * `fid` is nullable: an unknown fid answers HTTP 200 with the sparse shape
 * (all fields null), so the miss signal is `username == null` — not a status
 * code. `proNft` is deliberately typed `unknown` — no non-null sample has
 * ever been observed, so no shape is assumed (profile pages don't render it).
 *
 * Identity law (2026-10-27): the fname is the account's PRIMARY handle and
 * any number of ENS names are attestations. Both arrive from shim only when
 * it knows the proofs — optional here, so stale shim caches (old entity
 * shape) and a not-yet-upgraded shim degrade to the pre-law rendering.
 */
export type ShimUser = {
	fid?: number;
	username?: string | null;
	/** The account's fname — the PRIMARY handle under the identity law. */
	fname?: string | null;
	/** Verified ENS names (L1 + L2/basenames), in shim proof order. */
	attestations?: string[] | null;
	displayName?: string | null;
	pfpUrl?: string | null;
	bio?: string | null;
	primaryAddress?: string | null;
	proNft?: unknown;
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
 * The same lookup against an arbitrary shim-shaped host — the shim-potato
 * canary leg races this (cast-source.ts). The response contract is the
 * canonical shim's, byte for byte: HTTP 200 `{"success":false}`/empty
 * body on a miss, non-2xx is an outage, not a verdict.
 */
export async function getCastByUsernameHashFrom(
	base: string,
	username: string,
	hash: string,
	signal: AbortSignal,
): Promise<ShimLookup> {
	try {
		const res = await fetch(`${base}/wc/${username}/${hash}`, { signal });
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
 * Raced against the potato when `potatoBases` is set (the quote hydrator's
 * primary hop — a potato hit rescues a slow cloud index).
 */
export async function getCastByHash(
	hash: string,
	signal: AbortSignal,
	potatoBases?: string | null,
): Promise<ShimCast | undefined> {
	const probe = async (base: string): Promise<ShimProbe<ShimCast>> => {
		try {
			const res = await fetch(`${base}/h/${hash}`, { signal });
			if (!res.ok) {
				// Non-2xx is an outage signal — potato-rescuable, never a verdict.
				return {
					kind: "error",
					error: new Error(`shim /h HTTP ${res.status}`),
					fallback: undefined,
				};
			}
			const data = (await res.json().catch(() => undefined)) as {
				cast?: ShimCast;
			};
			const cast = data?.cast ?? undefined;
			return cast
				? { kind: "found", value: cast }
				: { kind: "miss", fallback: undefined };
		} catch (error) {
			return { kind: "error", error, fallback: undefined };
		}
	};
	const result = await raceShimProbe(probe, potatoBases);
	return result.kind === "found" ? result.value : result.fallback;
}

/**
 * GET /wc/{username}/{hash} — a miss is `{"success":false}` or an empty
 * body, both HTTP 200; a non-2xx or a thrown request is an error carrying
 * the same message text the provider race has always produced. Raced
 * against the potato when `potatoBases` is set — a found either way wins;
 * the terminal is always cloud's own lookup (misses stay authoritative).
 */
export async function getCastByUsernameHash(
	username: string,
	hash: string,
	signal: AbortSignal,
	potatoBases?: string | null,
): Promise<ShimLookup> {
	const probe = async (base: string): Promise<ShimProbe<ShimLookup>> => {
		// getCastByUsernameHashFrom never throws — its own contract.
		const lookup = await getCastByUsernameHashFrom(base, username, hash, signal);
		if (lookup.status === "found") return { kind: "found", value: lookup };
		return lookup.status === "miss"
			? { kind: "miss", fallback: lookup }
			: { kind: "error", error: new Error(lookup.message), fallback: lookup };
	};
	const result = await raceShimProbe(probe, potatoBases);
	// The fallback is always the cloud leg's own lookup (never undefined in
	// practice); the default keeps the ShimLookup contract total.
	return result.kind === "found"
		? result.value
		: (result.fallback ?? { status: "miss" });
}

/**
 * POST /refresh {fids:[fid]} — pull that fid's recent casts into shim's
 * Postgres index, so a hash /h missed (cold — the index only holds
 * kept-warm fids) hits next time. Both indexes warm when `potatoBases` is
 * set (the potato's /h can only win if its index knows the fid too).
 * Fire-and-forget by contract: callers run it under waitUntil and never
 * await it on the response path; the generous cap only bounds the
 * background lifetime. Never throws.
 */
export function warmShimHashIndex(
	fid: number,
	potatoBases?: string | null,
): Promise<unknown> {
	const warm = (base: string) =>
		fetch(`${base}/refresh`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ fids: [fid] }),
			signal: AbortSignal.timeout(15_000),
		}).catch(() => undefined);
	const legs: Promise<unknown>[] = [warm(SHIM_CLOUD_BASE)];
	if (potatoBases && potatoBases !== SHIM_CLOUD_BASE) legs.push(warm(potatoBases));
	return Promise.all(legs);
}

/**
 * GET /f/{username} — username → fid. Undefined when missing or malformed.
 * Cloud non-2xx/network rejections propagate (an outage, NOT a miss —
 * retriable upstream); raced against the potato when `potatoBases` is set
 * (a potato fid rescues a slow or erroring cloud; a cloud miss still 404s).
 */
export async function getFidByUsername(
	username: string,
	signal: AbortSignal,
	potatoBases?: string | null,
): Promise<number | undefined> {
	const probe = async (base: string): Promise<ShimProbe<number>> => {
		try {
			const res = await fetch(`${base}/f/${username}`, { signal });
			// A shim non-2xx is an outage signal, NOT a miss — it propagates so
			// callers can distinguish "no such username" (undefined) from "shim is
			// wrong right now" (throw ⇒ retriable/unreachable). Network rejections
			// already propagate.
			if (!res.ok) {
				return {
					kind: "error",
					error: new Error(`shim /f HTTP ${res.status}`),
					fallback: undefined,
				};
			}
			const data = (await res.json().catch(() => undefined)) as
				| { success?: boolean; fid?: number }
				| undefined;
			const fid = data?.fid;
			return typeof fid === "number"
				? { kind: "found", value: fid }
				: { kind: "miss", fallback: undefined };
		} catch (error) {
			return { kind: "error", error, fallback: undefined };
		}
	};
	const result = await raceShimProbe(probe, potatoBases);
	if (result.kind === "error") throw result.error;
	return result.kind === "found" ? result.value : result.fallback;
}

/**
 * GET /u/{fid} — fid → username. null when shim doesn't know the fid or
 * the answer is malformed. Cloud network rejections propagate to the
 * caller (the alias tails turn them into 503s); raced against the potato.
 */
export async function getUsernameByFid(
	fid: number,
	signal: AbortSignal,
	potatoBases?: string | null,
): Promise<string | null> {
	const probe = async (base: string): Promise<ShimProbe<string>> => {
		try {
			const res = await fetch(`${base}/u/${fid}`, { signal });
			if (!res.ok) return { kind: "miss", fallback: undefined };
			const data = (await res.json().catch(() => undefined)) as
				| { success?: boolean; username?: string }
				| undefined;
			const username = data?.username;
			return typeof username === "string" && username !== ""
				? { kind: "found", value: username }
				: { kind: "miss", fallback: undefined };
		} catch (error) {
			return { kind: "error", error, fallback: undefined };
		}
	};
	const result = await raceShimProbe(probe, potatoBases);
	if (result.kind === "error") throw result.error;
	return result.kind === "found" ? result.value : (result.fallback ?? null);
}

/**
 * GET /user/{fid} — the hydrated user entity. undefined on any cloud
 * failure (non-2xx, parse, thrown): callers treat undefined as
 * "decoration unavailable" and fail soft. A sparse shape (all nulls) is a
 * real answer, not an error — callers check `username == null` for the
 * miss verdict. Only a NON-sparse entity is a raceable found: a potato
 * sparse shape must never 404 a profile the cloud leg would resolve.
 * Raced against the potato when `potatoBases` is set.
 */
export async function getUserByFid(
	fid: number,
	signal: AbortSignal,
	potatoBases?: string | null,
): Promise<ShimUser | undefined> {
	const probe = async (base: string): Promise<ShimProbe<ShimUser>> => {
		try {
			const res = await fetch(`${base}/user/${fid}`, { signal });
			if (!res.ok) {
				// Non-2xx is an outage signal — potato-rescuable, never a verdict.
				return {
					kind: "error",
					error: new Error(`shim /user HTTP ${res.status}`),
					fallback: undefined,
				};
			}
			const data = (await res.json().catch(() => undefined)) as
				| { success?: boolean; user?: ShimUser | null }
				| undefined;
			const user = data?.user ?? undefined;
			if (user?.username != null) return { kind: "found", value: user };
			// Sparse (or absent) — replayed verbatim only from the cloud leg.
			return { kind: "miss", fallback: user };
		} catch (error) {
			return { kind: "error", error, fallback: undefined };
		}
	};
	const result = await raceShimProbe(probe, potatoBases);
	// Never throws — a cloud outage degrades to undefined, as always.
	return result.kind === "found" ? result.value : result.fallback;
}

/**
 * GET /{username}/casts-and-replies?limit=N — the N latest casts and
 * replies, canonical ShimCast rows (unix-SECOND timestamps, raw embeds, no
 * inline `user` — the author is the requested profile). `success:false`
 * (shim's "User not found") and any transport failure both resolve to
 * `ok:false`: the timeline is content that fails soft, never load-bearing
 * for identity. Raced against the potato — its ok timeline rescues a
 * slow/erroring cloud leg.
 */
export async function getCastsAndReplies(
	username: string,
	limit: number,
	signal: AbortSignal,
	potatoBases?: string | null,
): Promise<{ casts: ShimCast[]; ok: boolean }> {
	const empty = { casts: [] as ShimCast[], ok: false };
	const probe = async (
		base: string,
	): Promise<ShimProbe<{ casts: ShimCast[]; ok: boolean }>> => {
		try {
			const res = await fetch(`${base}/${username}/casts-and-replies?limit=${limit}`, { signal });
			if (!res.ok) {
				// Non-2xx is an outage signal — potato-rescuable, never a verdict.
				return {
					kind: "error",
					error: new Error(`shim timeline HTTP ${res.status}`),
					fallback: empty,
				};
			}
			const data = (await res.json().catch(() => undefined)) as
				| { success?: boolean; casts?: ShimCast[] }
				| undefined;
			if (!data || data.success === false || !Array.isArray(data.casts)) {
				return { kind: "miss", fallback: empty };
			}
			return { kind: "found", value: { casts: data.casts, ok: true } };
		} catch (error) {
			// The timeline never throws — a transport failure is ok:false.
			return { kind: "error", error, fallback: empty };
		}
	};
	const result = await raceShimProbe(probe, potatoBases);
	return result.kind === "found" ? result.value : (result.fallback ?? empty);
}

/**
 * GET /signed/{fid} — has the fid signed the social smart contract?
 * null = unknown (non-2xx, malformed, thrown): callers fail open.
 * Raced against the potato — first boolean answer wins, unknown fails
 * open exactly as before.
 */
export async function getSignedStatus(
	fid: number,
	signal: AbortSignal,
	potatoBases?: string | null,
): Promise<boolean | null> {
	const probe = async (base: string): Promise<ShimProbe<boolean>> => {
		try {
			const res = await fetch(`${base}/signed/${fid}`, { signal });
			if (!res.ok) {
				// Non-2xx is an outage signal — potato-rescuable; unknown (null)
				// still fails open if the potato yields nothing either.
				return {
					kind: "error",
					error: new Error(`shim /signed HTTP ${res.status}`),
					fallback: undefined,
				};
			}
			const data = (await res.json().catch(() => ({}))) as {
				signed?: boolean;
			};
			if (typeof data.signed === "boolean")
				return { kind: "found", value: data.signed };
			return { kind: "miss", fallback: undefined };
		} catch (error) {
			return { kind: "error", error, fallback: undefined };
		}
	};
	const result = await raceShimProbe(probe, potatoBases);
	return result.kind === "found" ? result.value : (result.fallback ?? null);
}
