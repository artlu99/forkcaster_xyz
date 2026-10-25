// Cast source race — rpc-racer pattern (github.com/stephancill/rpc-racer)
// adapted from JSON-RPC to cast lookups: fan out all eligible providers,
// first VALIDATED success wins, losers are aborted, failures never win.
//
// Providers are tiered by completeness (measured Oct 2026, see README):
// - shim       — complete. Canonical shape, short/full hashes, quotes inline.
// - haatz/snap — complete raw Snapchain messages, but castById needs an fid
//                and a FULL hash (short hashes 400). The fid is raced between
//                shim /f/{username} and the node's own
//                /v1/userNameProofByName — neither source is a single point
//                of failure, so a shim outage can't blind both providers.
// - farcaster.tv — quote-blind: it silently DROPS {castId} quote embeds, so
//                its wins are marked partial and only allowed after the box
//                expires; the HTML self-heals quote cards via ?embeds=quotes.
//
// The signed (ban) check is deliberately NOT part of this race: it stays a
// shim dependency, orthogonal to cast content (see resolveCast).
//
// No caching is introduced here: one fan-out per render keeps the last-used
// badge and signed suppression trivially correct.

import { sort } from "radash";
import {
	getCastByUsernameHash,
	getFidByUsername,
	resolvesHash,
	type ShimCast,
	type ShimEmbed,
} from "./shim.ts";

export type { ShimCast, ShimEmbed };

export type ProviderId = "shim" | "haatz" | "snap" | "farcaster-tv";

/**
 * How resolveFid's two-source identity race settled on a raw-node leg —
 * which source named the fid first and how fast: shim, or the leg's own
 * gateway (winner id = the leg id). Public reporting: /transparency's
 * "Author id races" item. No cast identifiers.
 */
export type FidRace = { winner: "shim" | "haatz" | "snap"; ms: number };

/** What a request can supply before any cast data exists. */
export interface CastVars {
	username: string;
	/** Route-form hash, short or full, exactly as requested. */
	hash: string;
}

export type ProviderResult =
	| {
			kind: "found";
			provider: ProviderId;
			/** Complete providers preserve raw {castId} embeds; partial don't. */
			complete: boolean;
			cast: ShimCast & { hash: string };
			/** Raw-node legs: how the fid race settled. */
			fidRace?: FidRace;
	  }
	| { kind: "miss"; provider: ProviderId }
	| { kind: "error"; provider: ProviderId; message: string };

export interface CastProvider {
	id: ProviderId;
	complete: boolean;
	/** Whether this provider can key off (username, hash) alone. */
	canServe(vars: CastVars): boolean;
	fetchCast(vars: CastVars, signal: AbortSignal): Promise<ProviderResult>;
}

/** Per-provider outcome observed for one race — one row per eligible provider. */
export interface ProviderTiming {
	provider: ProviderId;
	/**
	 * `abort` marks losers cut off when the race resolved — race bookkeeping,
	 * not provider failures (kept out of public errorRate).
	 */
	kind: "found" | "miss" | "error" | "abort";
	/** Milliseconds from race start to this provider's settle. */
	ms: number;
	/**
	 * Raw-node legs only: the leg's identity-race outcome. Absent when the
	 * leg was cut off mid-race (abort) or neither source answered.
	 */
	fid?: FidRace;
}

export type RaceResult =
	| {
			kind: "found";
			cast: ShimCast & { hash: string };
			provider: ProviderId;
			/** True when the winner was quote-blind (farcaster.tv). */
			partial: boolean;
			timings: ProviderTiming[];
			elapsedMs: number;
	  }
	| {
			kind: "not-found";
			timings: ProviderTiming[];
			elapsedMs: number;
	  }
	| {
			kind: "unreachable";
			timings: ProviderTiming[];
			elapsedMs: number;
	  };

/** Snapchain message timestamps count from 2021-01-01T00:00:00Z. */
const FARCASTER_EPOCH = 1609459200;
/**
 * Hard cap for every upstream call in the worker — each race leg and each
 * Shim/enrichment call in cast-page rides on it. Shim's cold sharded
 * lookups can otherwise hang 15s+.
 */
export const UPSTREAM_TIMEOUT_MS = 5000;

function isFullHash(hash: string): boolean {
	return /^0x[0-9a-fA-F]{40}$/.test(hash);
}

/** A found cast is only valid if it resolves the hash that was asked for. */
function resolvesRequested(vars: CastVars, cast: ShimCast): boolean {
	return resolvesHash(cast.hash, vars.hash);
}

async function getJsonWithStatus(
	url: string,
	signal: AbortSignal,
): Promise<{ status: number; data: unknown | undefined }> {
	const res = await fetch(url, { signal });
	const data = res.ok ? await res.json().catch(() => undefined) : undefined;
	return { status: res.status, data };
}

// --- shim (complete, canonical shape, any hash form) — identity calls
// --- live in shim.ts; this adapter maps them onto race semantics.

export const shimProvider: CastProvider = {
	id: "shim",
	complete: true,
	canServe: () => true,
	async fetchCast(vars, signal) {
		const lookup = await getCastByUsernameHash(
			vars.username,
			vars.hash,
			signal,
		);
		if (lookup.status === "error") {
			return { kind: "error", provider: "shim", message: lookup.message };
		}
		if (lookup.status === "miss") return { kind: "miss", provider: "shim" };
		return { kind: "found", provider: "shim", complete: true, cast: lookup.cast };
	},
};

// --- farcaster.tv (quote-blind partial, any hash form via prefix match) ---

function mapFarcasterTvCast(raw: unknown): ShimCast & { hash: string } {
	const c = raw as {
		hash?: string;
		text?: string;
		timestamp?: number;
		author?: {
			fid?: number;
			username?: string;
			displayName?: string;
			pfp?: { url?: string };
			profile?: { bio?: { text?: string } };
		};
		embeds?: {
			images?: Array<{ openGraph?: { url?: string; sourceUrl?: string } }>;
			urls?: Array<{ openGraph?: { url?: string; sourceUrl?: string } }>;
		};
	};
	const embeds: ShimEmbed[] = [];
	for (const image of c.embeds?.images ?? []) {
		const url = image.openGraph?.sourceUrl ?? image.openGraph?.url;
		if (url) embeds.push({ url });
	}
	for (const link of c.embeds?.urls ?? []) {
		const url = link.openGraph?.url ?? link.openGraph?.sourceUrl;
		if (url) embeds.push({ url });
	}
	const author = c.author ?? {};
	return {
		fid: author.fid,
		hash: c.hash as string,
		text: c.text,
		// farcaster.tv timestamps are unix milliseconds.
		timestamp:
			typeof c.timestamp === "number"
				? Math.floor(c.timestamp / 1000)
				: undefined,
		embeds,
		user: {
			fid: author.fid,
			username: author.username,
			displayName: author.displayName,
			pfpUrl: author.pfp?.url,
			bio: author.profile?.bio?.text,
		},
	};
}

export const farcasterTvProvider: CastProvider = {
	id: "farcaster-tv",
	// Quote embeds are dropped by farcaster.tv — wins from it are partial.
	complete: false,
	canServe: () => true,
	async fetchCast(vars, signal) {
		try {
			const res = await fetch(
				`https://farcaster.tv/${vars.username}/${vars.hash}`,
				{ signal },
			);
			if (res.status === 404) {
				return { kind: "miss", provider: "farcaster-tv" };
			}
			if (!res.ok) {
				return {
					kind: "error",
					provider: "farcaster-tv",
					message: `HTTP ${res.status}`,
				};
			}
			const data = (await res.json().catch(() => undefined)) as {
				result?: { casts?: unknown[] };
			};
			const match = (data?.result?.casts ?? []).find((raw) => {
				const hash = (raw as { hash?: string })?.hash;
				return (
					typeof hash === "string" &&
					hash.toLowerCase().startsWith(vars.hash.toLowerCase())
				);
			});
			if (match === undefined) {
				return {
					kind: "error",
					provider: "farcaster-tv",
					message: "no matching cast in response",
				};
			}
			return {
				kind: "found",
				provider: "farcaster-tv",
				complete: false,
				cast: mapFarcasterTvCast(match),
			};
		} catch (error) {
			return {
				kind: "error",
				provider: "farcaster-tv",
				message: String(error),
			};
		}
	},
};

// --- raw Snapchain nodes: haatz + snap (complete, fid + full hash only) ---
//
// Both expose the Snapchain HTTP gateway API family: /v1/castById needs
// fid + FULL hash (short hashes 400 with NotFound). The fid is raced
// between shim /f/{username} and the gateway's own
// /v1/userNameProofByName — resolveFid below. userDataByFid supplies
// the inline user data the other providers carry natively.

type RawMessage = {
	hash?: string;
	data?: {
		type?: string;
		fid?: number;
		timestamp?: number;
		castAddBody?: {
			text?: string;
			embeds?: ShimEmbed[];
		};
		userDataBody?: { type?: string; value?: string };
	};
};

function mapRawCast(
	message: RawMessage,
	vars: CastVars,
	userMessages: RawMessage[],
): ShimCast & { hash: string } {
	const body = message.data?.castAddBody ?? {};
	const embeds: ShimEmbed[] = (body.embeds ?? []).filter(
		(embed) => typeof embed?.url === "string" || embed?.castId !== undefined,
	);
	// Latest message per user-data type wins — sort newest-first so the
	// verdict doesn't depend on the gateway's row order (timestamps are
	// Farcaster-epoch; only relative order matters).
	const user: ShimCast["user"] = { fid: message.data?.fid };
	const latestFirst = sort(userMessages, (m) => m.data?.timestamp ?? 0, true);
	for (const m of latestFirst) {
		const { type, value } = m.data?.userDataBody ?? {};
		if (typeof value !== "string") continue;
		if (type === "USER_DATA_TYPE_USERNAME") user.username = value;
		else if (type === "USER_DATA_TYPE_DISPLAY") user.displayName = value;
		else if (type === "USER_DATA_TYPE_PFP") user.pfpUrl = value;
		else if (type === "USER_DATA_TYPE_BIO") user.bio = value;
	}
	return {
		fid: message.data?.fid,
		hash: message.hash as string,
		text: body.text,
		timestamp:
			typeof message.data?.timestamp === "number"
				? message.data.timestamp + FARCASTER_EPOCH
				: undefined,
		embeds,
		user: { ...user, username: user.username ?? vars.username },
	};
}

/**
 * username → fid for the raw-node legs, RACED shim-vs-node (the
 * rpc-racer pattern at identity scale): both sources fire under the
 * leg's abort window, the first numeric answer wins, the loser is
 * aborted, and a miss or failure from one source never wins while the
 * other is still pending. Neither source is on the critical path — a
 * hanging shim costs nothing when the node answers first, and vice
 * versa (both observed live Oct 2026). A stale fid for a transferred
 * username can never win — the central hash validation
 * rejects any cast that doesn't resolve the requested hash.
 */
async function resolveFid(
	id: "haatz" | "snap",
	base: string,
	username: string,
	signal: AbortSignal,
): Promise<{ fid: number | undefined; race?: FidRace }> {
	const startedAt = Date.now();
	const shim = new AbortController();
	const node = new AbortController();
	// The leg's 5s cap propagates to both sources; a winner aborts only
	// its loser.
	const forward = () => {
		shim.abort();
		node.abort();
	};
	if (signal.aborted) forward();
	else signal.addEventListener("abort", forward, { once: true });
	const detach = () => signal.removeEventListener("abort", forward);
	const fromShim = getFidByUsername(username, shim.signal);
	const fromNode = (async () => {
		const { status, data } = await getJsonWithStatus(
			`${base}/v1/userNameProofByName?name=${encodeURIComponent(username)}`,
			node.signal,
		);
		if (status !== 200) return undefined;
		const fid = (data as { fid?: unknown } | undefined)?.fid;
		return typeof fid === "number" ? fid : undefined;
	})();
	return new Promise<{ fid: number | undefined; race?: FidRace }>((resolve) => {
		let pending = 2;
		const onSettle = (
			winner: FidRace["winner"],
			loser: AbortController,
		) => (fid: number | undefined) => {
			if (typeof fid === "number") {
				detach();
				loser.abort();
				resolve({
					fid,
					race: { winner, ms: Date.now() - startedAt },
				});
				return;
			}
			if (--pending === 0) {
				detach();
				resolve({ fid: undefined });
			}
		};
		// Rejections (shim outage, node 5xx/abort) settle as undefined —
		// only a numeric fid wins; the last source standing decides. The
		// node's win is labeled with its own id (per-node tracking on
		// /transparency).
		fromShim.then(onSettle("shim", node), () =>
			onSettle("shim", node)(undefined),
		);
		fromNode.then(onSettle(id, shim), () =>
			onSettle(id, shim)(undefined),
		);
	});
}

function rawNodeProvider(id: "haatz" | "snap", base: string): CastProvider {
	return {
		id,
		complete: true,
		canServe: (vars) => isFullHash(vars.hash),
		async fetchCast(vars, signal) {
			try {
				const { fid, race } = await resolveFid(
					id,
					base,
					vars.username,
					signal,
				);
				if (fid === undefined) {
					return {
						kind: "error",
						provider: id,
						message: "no fid for username",
					};
				}
				const { status, data } = await getJsonWithStatus(
					`${base}/v1/castById?fid=${fid}&hash=${vars.hash}`,
					signal,
				);
				if (status === 400) {
					// The raw nodes' not-found ({"error":"Failed to get cast"}).
					// Non-ok bodies are never parsed below, so the status code is
					// the whole verdict here.
					return { kind: "miss", provider: id };
				}
				const message = data as RawMessage | undefined;
				if (!message?.hash || !message.data?.castAddBody) {
					return { kind: "error", provider: id, message: `HTTP ${status}` };
				}
				if (message.data.type !== "MESSAGE_TYPE_CAST_ADD") {
					// Cast removed (or a non-add message): nothing to render.
					return { kind: "miss", provider: id };
				}
				// User data is decoration — an outage here must not fail the cast.
				const userData = await getJsonWithStatus(
					`${base}/v1/userDataByFid?fid=${fid}`,
					signal,
				);
				const userMessages =
					(
						userData.data as { messages?: RawMessage[] } | undefined
					)?.messages?.slice(0, 50) ?? [];
				return {
					kind: "found",
					provider: id,
					complete: true,
					cast: mapRawCast(message, vars, userMessages),
					fidRace: race,
				};
			} catch (error) {
				return { kind: "error", provider: id, message: String(error) };
			}
		},
	};
}

export const haatzProvider = rawNodeProvider(
	"haatz",
	"https://haatz.quilibrium.com",
);
// The official Snapchain gateway answers on :3381 only (443 hangs).
export const snapProvider = rawNodeProvider(
	"snap",
	"https://snap.farcaster.xyz:3381",
);

export const PROVIDERS: CastProvider[] = [
	shimProvider,
	haatzProvider,
	snapProvider,
	farcasterTvProvider,
];

type RaceEvent =
	| { deadline: true }
	| { deadline?: false; provider: ProviderId; result: ProviderResult };

/**
 * Race the eligible providers. Semantics:
 * - A complete provider's validated `found` wins immediately.
 * - A partial (quote-blind) `found` may only win once the box expires —
 *   boxMs 0 disables the wait (partial wins as soon as it lands).
 * - A miss from a COMPLETE provider is authoritative ⇒ not-found, even if
 *   a partial found landed first (parity with the old shim-miss ⇒ 404).
 *   Shim's miss additionally resolves the race immediately (fast 404s).
 * - Anything else after all providers settle ⇒ unreachable.
 * Losers are aborted when the race resolves.
 */
export async function raceCast(
	vars: CastVars,
	opts: { providers?: CastProvider[]; boxMs?: number } = {},
): Promise<RaceResult> {
	const roster = opts.providers ?? PROVIDERS;
	const eligible = roster.filter((provider) => provider.canServe(vars));
	const startedAt = Date.now();
	const finish = (): { timings: ProviderTiming[]; elapsedMs: number } => ({
		timings,
		elapsedMs: Date.now() - startedAt,
	});
	if (eligible.length === 0)
		return { kind: "unreachable", timings: [], elapsedMs: 0 };
	const isComplete = new Map(eligible.map((p) => [p.id, p.complete]));

	const controllers = new Map<ProviderId, AbortController>();
	const timings: ProviderTiming[] = [];
	// Set once the race has resolved: aborts from here on are the race
	// cutting off losers, not provider failures (see settled()).
	let raceOver = false;
	const abortAll = () => {
		raceOver = true;
		for (const controller of controllers.values()) controller.abort();
	};

	const pending = new Map<ProviderId, Promise<RaceEvent>>();
	for (const provider of eligible) {
		const controller = new AbortController();
		controllers.set(provider.id, controller);
		const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
		const providerStartedAt = Date.now();
		const settled = (kind: ProviderTiming["kind"], fid?: FidRace): void => {
			timings.push({
				provider: provider.id,
				// Aborted losers are race bookkeeping, not provider errors —
				// record them as `abort` so public errorRate stays honest.
				// (The 5s hard-timeout abort fires while the race is still
				// pending, so raceOver is false there and it stays an `error`.
				// A real error landing in the post-resolution grace window is
				// likewise relabeled `abort` — accepted telemetry fuzz.)
				kind:
					kind === "error" && raceOver && controller.signal.aborted
						? "abort"
						: kind,
				ms: Date.now() - providerStartedAt,
				fid,
			});
		};
		pending.set(
			provider.id,
			provider
				.fetchCast(vars, controller.signal)
				.then((result): RaceEvent => {
					clearTimeout(timer);
					// Central validation: downgrade mismatches to errors so an
					// off-target response can never win. The fid race still
					// settled on the found result — keep its datapoint.
					if (
						result.kind === "found" &&
						!resolvesRequested(vars, result.cast)
					) {
						settled("error", result.fidRace);
						return {
							provider: provider.id,
							result: {
								kind: "error",
								provider: provider.id,
								message: "response does not resolve requested hash",
							},
						};
					}
					settled(
						result.kind,
						result.kind === "found" ? result.fidRace : undefined,
					);
					return { provider: provider.id, result };
				})
				.catch((error): RaceEvent => {
					clearTimeout(timer);
					settled("error");
					return {
						provider: provider.id,
						result: {
							kind: "error",
							provider: provider.id,
							message: String(error),
						},
					};
				}),
		);
	}

	const deadline = Date.now() + (opts.boxMs ?? 700);
	let partial: Extract<ProviderResult, { kind: "found" }> | null = null;
	let completeMiss = false;
	let winner: Extract<ProviderResult, { kind: "found" }> | null = null;
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

	while (pending.size > 0) {
		const events: Promise<RaceEvent>[] = [...pending.values()];
		// Arm the box only once a partial has landed and no complete provider
		// has authoritatively missed — otherwise there is nothing to wake for.
		if (partial !== null && !completeMiss && Date.now() < deadline) {
			// A prior iteration's box may still be armed (it lost the last
			// race to a provider event) — clear it before re-arming.
			if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
			events.push(
				new Promise<RaceEvent>((resolve) => {
					deadlineTimer = setTimeout(
						() => resolve({ deadline: true }),
						deadline - Date.now(),
					);
				}),
			);
		}
		const event = await Promise.race(events);
		if (event.deadline) {
			// Box expired: the quote-blind copy is better than more waiting.
			winner = partial;
			break;
		}
		pending.delete(event.provider);
		const result = event.result;
		if (result.kind === "found") {
			if (result.complete) {
				winner = result;
				break;
			}
			partial ??= result;
			if (Date.now() >= deadline && !completeMiss) {
				winner = result;
				break;
			}
		} else if (result.kind === "miss") {
			if (event.provider === "shim") {
				// Shim's miss verdict is the system's original authoritative
				// not-found — resolve immediately, no box wait (fast 404s).
				completeMiss = true;
				break;
			}
			if (isComplete.get(event.provider)) completeMiss = true;
		}
	}
	if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
	abortAll();
	// Give cut-off losers a beat to land their `abort` timing rows before
	// the result escapes — deterministic telemetry, bounded so a provider
	// that ignores its signal can't stall the response.
	if (pending.size > 0) {
		await Promise.race([
			Promise.allSettled([...pending.values()]),
			new Promise((resolve) => setTimeout(resolve, 25)),
		]);
	}

	if (winner !== null) {
		return {
			kind: "found",
			cast: winner.cast,
			provider: winner.provider,
			partial: !winner.complete,
			...finish(),
		};
	}
	if (completeMiss) return { kind: "not-found", ...finish() };
	if (partial !== null) {
		return {
			kind: "found",
			cast: partial.cast,
			provider: partial.provider,
			partial: true,
			...finish(),
		};
	}
	return { kind: "unreachable", ...finish() };
}
