// Shim identity client — the one place that knows shim's routes, shapes,
// and base URL. Zero dependencies; consumers (the provider race, the quote
// hydrator, the signed check — and standalone builds like the MCP server)
// vendor or import this file.
//
// Identity resolution is shim-direct: shim is the canonical identity source
// (same trust position as the ban signal). These wrappers preserve each
// call site's exact failure semantics — see the per-function notes.

/** Base URL of the shim cloud reader — retired Nov 2026 (the Render
 * instance was decommissioned after the shim-cloud retirement pruned the
 * base from the production fleet var). The constant survives as the
 * legacy no-var roster's target (dev/test and vendored surfaces) and as
 * the fleetSeatId mapping that keeps the historical "shim-cloud" stats id
 * honest (its hostname label is "shim", which is a different, older
 * series). Production must carry the var: the retired host answers
 * nothing. */
export const SHIM_CLOUD_BASE = "https://shim.artlu.xyz";

import { collectiveRace, staggerDelays, type RaceLeg } from "./race.ts";

/**
 * One shim leg's terminal state — the raced wrappers below speak in these.
 * `found` is an affirmative answer any source may produce; `miss` carries
 * `fallback`, the primary-shaped answer for that exact response, so the
 * wrapper replays each endpoint's per-endpoint verdict byte-for-byte when
 * the primary leg is the terminal (sparse users, ok:false timelines, null
 * handles…); `error` carries the thrown value the primary's contract
 * propagates (outage signals) plus the never-throw fallback for fail-soft
 * endpoints. (The general shape lives in race.ts — this alias keeps the
 * shim-flavored name every wrapper and call site already speaks.)
 */
export type ShimProbe<T> = RaceLeg<T>;

/**
 * Race the shim fleet (`potatoBases` — the raw var value, one or more
 * comma-separated base URLs) under the caller's AbortSignal: the shared
 * collective-race machinery (race.ts) with one leg per var base. The var
 * IS the fleet — cloud holds no special seat (cloud-retirement cutover),
 * and since the shim-cloud retirement (Nov 2026) the production var
 * carries only the potato members; cloud's base rides the var like any
 * member's would, first entry leads at 0ms and
 * later members stagger in one tiny random step apart. Fleet semantics —
 * no single host is the source of truth:
 *
 * - the FIRST affirmative (found) answer wins outright;
 * - a consulted miss (HTTP 200, index asked, no data) is a VOTE, not a
 *   verdict: not-found settles only when every leg has missed. A pending
 *   leg can still rescue a miss that already landed;
 * - errors (non-2xx/timeout — outage signals) never decide anything:
 *   they surface (the PRIMARY — first var entry — leg's, for message
 *   stability) only when every leg errored;
 * - latency of a true miss = the slowest leg's miss (bounded by the
 *   caller's signal) — the deliberate price of softening the SPOF.
 *
 * Without `potatoBases` this is a pass-through to cloud — identical
 * fetches, zero overhead (the legacy no-var roster; what keeps every test
 * and caller honest). Since the Nov 2026 retirement the legacy roster
 * targets the DECOMMISSIONED cloud host — dev/test scaffolding only:
 * production and any vendored deployment must set the var.
 */
export async function raceShimProbe<T>(
	probe: (base: string) => Promise<ShimProbe<T>>,
	potatoBases?: string | null,
): Promise<ShimProbe<T>> {
	const bases = fleetBases(potatoBases);
	if (bases.length === 0) return probe(SHIM_CLOUD_BASE);
	return collectiveRace({
		legs: bases.map((base) => () => probe(base)),
		delays: staggerDelays(bases.length),
	});
}

/**
 * Parse the fleet list: comma-separated base URLs, trimmed, trailing
 * slashes stripped, deduped. The SHIM_POTATO_BASE var carries the FULL
 * shim fleet (cloud-retirement cutover) — every entry is a fleet member;
 * since the shim-cloud retirement (Nov 2026) the production var carries
 * only the potato members, but the parsing stays base-agnostic: a cloud
 * base in any var (dev/test fixtures) is still a member. Var order is the
 * stagger/primary order — who leads at 0ms — and nothing else. A host's
 * stats id is its own name (fleetSeatId), so leaving or rejoining does
 * not renumber anyone else.
 */
export function fleetBases(potatoBasess?: string | null): string[] {
	const out: string[] = [];
	for (const raw of (potatoBasess ?? "").split(",")) {
		const base = raw.trim().replace(/\/+$/, "");
		if (base === "" || out.includes(base)) continue;
		out.push(base);
	}
	return out;
}

/**
 * First DNS label of a base URL (`shim-potato-4` from
 * `https://shim-potato-4.artlu.xyz`). Empty when the base has none.
 */
function hostLabel(base: string): string {
	const noScheme = base.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
	const host = noScheme.split("/")[0] ?? "";
	return (host.split(".")[0] ?? "").toLowerCase();
}

/** `shim-potato`, or `shim-potato-2`, `shim-potato-4`, … — the host's own name. */
const POTATO_SEAT = /^shim-potato(?:-\d+)?$/;

/**
 * Stats id for one fleet base, shared by the cast-race roster legs
 * (cast-source.ts), the fid-race winner vocabulary (cloud excepted — it
 * stays "shim" there), and the cross-fleet warm skip below.
 *
 * The id is the hostname's first label, never the var index. Two hosts
 * must not share a label: the race and the stats both key on it. Var
 * order only decides who leads and how the stagger steps. A host that leaves
 * the roster — for a re-deploy, or for good — stops writing under its
 * own id, and every other host keeps the series it already has. Putting
 * the host back resumes that same id.
 *
 * `shim-potato.artlu.xyz` → `shim-potato`. `shim-potato-4.artlu.xyz` →
 * `shim-potato-4`. The cloud base is the one exception: its label is
 * `shim`, which is the pre-cutover race-stats id and the fid-race name,
 * so the cast race keeps the post-rename id `shim-cloud`. That seat
 * wrote `shim-potato-3` for its first days under the old positional
 * scheme. `shim-potato-3` is not a hostname and must not be given to a
 * new machine — those points are still decaying through the stats
 * window (~Nov 12 2026).
 */
export function fleetSeatId(base: string): string {
	if (base === SHIM_CLOUD_BASE) return "shim-cloud";
	const label = hostLabel(base);
	if (POTATO_SEAT.test(label)) return label;
	// A host outside the potato naming scheme still must not inherit a
	// numbered seat. The label itself is already stable; `shim` is
	// reserved for the historical cloud series.
	const safe = label.replace(/[^a-z0-9-]/g, "");
	return safe !== "" && safe !== "shim" ? safe : "shim-unknown";
}

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
 * Cross-fleet warm: after a cast wins via one host, refresh every
 * OTHER shim-shaped host's index so the next visitor's read is warm there
 * too. The winner is warm by definition and is skipped — matched by the
 * fleet seat id its roster leg carries (fleetSeatId; the legacy
 * no-var roster's "shim" is cloud itself). Fire-and-forget by contract —
 * every leg swallows its own failures; never rejects.
 */
export function warmShimIndexForCast(
	fid: number,
	winnerProvider: string,
	potatoBases?: string | null,
): Promise<unknown> {
	const warm = (base: string) =>
		fetch(`${base}/refresh`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ fids: [fid] }),
			signal: AbortSignal.timeout(15_000),
		}).catch(() => undefined);
	const fleet = fleetBases(potatoBases);
	if (fleet.length === 0) {
		// Legacy no-var roster: cloud is the only shim-shaped host —
		// the decommissioned one, since the Nov 2026 retirement.
		return winnerProvider === "shim"
			? Promise.resolve()
			: warm(SHIM_CLOUD_BASE);
	}
	return Promise.all(
		fleet.map((base) =>
			fleetSeatId(base) === winnerProvider ? undefined : warm(base),
		),
	);
}

/**
 * GET /wc/{username}/{hash} — a miss is `{"success":false}` or an empty
 * body, both HTTP 200; a non-2xx or a thrown request is an error carrying
 * the same message text the provider race has always produced. Raced
 * across the fleet when `potatoBases` is set — a found either way wins;
 * the terminal replays the PRIMARY leg's own lookup (misses stay
 * consensus votes).
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
 * POST /refresh {fids:[fid]} — pull that fid's recent casts into a shim
 * host's Postgres index, so a hash /h missed (cold — the index only holds
 * kept-warm fids) hits next time. Every fleet member in the var warms
 * (no var: cloud only — the legacy single-host roster). Fire-and-forget
 * by contract: callers run it under waitUntil and never await it on the
 * response path; the generous cap only bounds the background lifetime.
 * Never throws.
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
	const fleet = fleetBases(potatoBases);
	// No var: the legacy cloud-only roster — the decommissioned host since
	// the Nov 2026 retirement (dev/test scaffolding only).
	const targets = fleet.length > 0 ? fleet : [SHIM_CLOUD_BASE];
	return Promise.all(targets.map(warm));
}

/**
 * GET /f/{username} — username → fid, WITH attribution: `winnerBase` is
 * the fleet member whose answer named the fid (undefined on a miss — no
 * numeric fid ever won). Cloud non-2xx/network rejections propagate (an
 * outage, NOT a miss — retriable upstream); raced across the full fleet
 * when `potatoBases` is set (a member's fid rescues a slow or erroring
 * primary; a fleet-wide miss still 404s).
 */
export async function raceFidByUsername(
	username: string,
	signal: AbortSignal,
	potatoBases?: string | null,
): Promise<{ fid?: number; winnerBase?: string }> {
	const probe = async (
		base: string,
	): Promise<ShimProbe<{ fid: number; base: string }>> => {
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
				? { kind: "found", value: { fid, base } }
				: { kind: "miss", fallback: undefined };
		} catch (error) {
			return { kind: "error", error, fallback: undefined };
		}
	};
	const result = await raceShimProbe(probe, potatoBases);
	if (result.kind === "error") throw result.error;
	return result.kind === "found"
		? { fid: result.value.fid, winnerBase: result.value.base }
		: { fid: undefined };
}

/**
 * GET /f/{username} — username → fid. Undefined when missing or malformed.
 * (The attribution-carrying form is raceFidByUsername — the raw-node
 * identity race uses it to label the fid-race winner.)
 */
export async function getFidByUsername(
	username: string,
	signal: AbortSignal,
	potatoBases?: string | null,
): Promise<number | undefined> {
	return (await raceFidByUsername(username, signal, potatoBases)).fid;
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
