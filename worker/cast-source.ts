// Cast source race — rpc-racer pattern (github.com/stephancill/rpc-racer)
// adapted from JSON-RPC to cast lookups: fan out all eligible providers,
// first VALIDATED success wins, losers are aborted, failures never win.
//
// Providers are tiered by completeness (measured Oct 2026, see README):
// - shim       — complete. Canonical shape, short/full hashes, quotes inline.
// - haatz/snap — complete raw Snapchain messages, but castById needs an fid
//                (resolved via shim /f/{username}) and a FULL hash; short-hash
//                URLs can't be keyed on a raw node (no usernameProof route).
// - farcaster.tv — quote-blind: it silently DROPS {castId} quote embeds, so
//                its wins are marked partial and only allowed after the box
//                expires; the HTML self-heals quote cards via ?embeds=quotes.
//
// The signed (ban) check is deliberately NOT part of this race: it stays a
// shim dependency, orthogonal to cast content (see resolveCast).
//
// No caching is introduced here: one fan-out per render keeps the last-used
// badge and signed suppression trivially correct.

export type ShimEmbed = { url?: string; castId?: { fid?: number; hash?: string } };
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

export type ProviderId = "shim" | "haatz" | "snap" | "farcaster-tv";

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

export type RaceResult =
	| {
			kind: "found";
			cast: ShimCast & { hash: string };
			provider: ProviderId;
			/** True when the winner was quote-blind (farcaster.tv). */
			partial: boolean;
	  }
	| { kind: "not-found" }
	| { kind: "unreachable" };

/** Snapchain message timestamps count from 2021-01-01T00:00:00Z. */
const FARCASTER_EPOCH = 1609459200;
/** Hard per-provider cap, matching the other Shim calls in the worker. */
const HARD_TIMEOUT_MS = 5000;

function isFullHash(hash: string): boolean {
	return /^0x[0-9a-fA-F]{40}$/.test(hash);
}

/** A found cast is only valid if it resolves the hash that was asked for. */
function resolvesRequested(vars: CastVars, cast: ShimCast): boolean {
	return (
		typeof cast.hash === "string" &&
		cast.hash.toLowerCase().startsWith(vars.hash.toLowerCase())
	);
}

async function getJson(
	url: string,
	signal: AbortSignal,
): Promise<unknown | undefined> {
	const res = await fetch(url, { signal });
	if (!res.ok) return undefined;
	return res.json().catch(() => undefined);
}

async function getJsonWithStatus(
	url: string,
	signal: AbortSignal,
): Promise<{ status: number; data: unknown | undefined }> {
	const res = await fetch(url, { signal });
	const data = res.ok ? await res.json().catch(() => undefined) : undefined;
	return { status: res.status, data };
}

// --- shim (complete, canonical shape, any hash form) ---

export const shimProvider: CastProvider = {
	id: "shim",
	complete: true,
	canServe: () => true,
	async fetchCast(vars, signal) {
		try {
			// A miss is {"success":false} or an empty body, both HTTP 200.
			const res = await fetch(
				`https://shim.artlu.xyz/wc/${vars.username}/${vars.hash}`,
				{ signal },
			);
			if (!res.ok) {
				return { kind: "error", provider: "shim", message: `HTTP ${res.status}` };
			}
			const data = (await res.json().catch(() => undefined)) as {
				success?: boolean;
				cast?: ShimCast;
			};
			const cast = data?.cast;
			if (data?.success === false || !cast?.hash) {
				return { kind: "miss", provider: "shim" };
			}
			return {
				kind: "found",
				provider: "shim",
				complete: true,
				cast: { ...cast, hash: cast.hash },
			};
		} catch (error) {
			return { kind: "error", provider: "shim", message: String(error) };
		}
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
			return { kind: "error", provider: "farcaster-tv", message: String(error) };
		}
	},
};

// --- raw Snapchain nodes: haatz + snap (complete, fid + full hash only) ---
//
// Both expose the Snapchain HTTP gateway API family: /v1/castById needs
// fid + FULL hash (short hashes 400 with NotFound) and no usernameProof
// route exists, so the fid comes from shim /f/{username} — a lightweight
// Redis lookup. userDataByFid supplies the inline user data the other
// providers carry natively.

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
	// Latest message per user-data type wins.
	const user: ShimCast["user"] = { fid: message.data?.fid };
	for (const m of userMessages) {
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

function rawNodeProvider(id: "haatz" | "snap", base: string): CastProvider {
	return {
		id,
		complete: true,
		canServe: (vars) => isFullHash(vars.hash),
		async fetchCast(vars, signal) {
			try {
				const fidData = (await getJson(
					`https://shim.artlu.xyz/f/${vars.username}`,
					signal,
				)) as { success?: boolean; fid?: number } | undefined;
				const fid = fidData?.fid;
				if (typeof fid !== "number") {
					return { kind: "error", provider: id, message: "no fid for username" };
				}
				const { status, data } = await getJsonWithStatus(
					`${base}/v1/castById?fid=${fid}&hash=${vars.hash}`,
					signal,
				);
				const message = data as RawMessage | undefined;
				if (status === 400 && !message?.hash) {
					// {"error":"Failed to get cast"} — the raw nodes' not-found.
					return { kind: "miss", provider: id };
				}
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
					(userData.data as { messages?: RawMessage[] } | undefined)?.messages?.slice(
						0,
						50,
					) ?? [];
				return {
					kind: "found",
					provider: id,
					complete: true,
					cast: mapRawCast(message, vars, userMessages),
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
	if (eligible.length === 0) return { kind: "unreachable" };
	const isComplete = new Map(eligible.map((p) => [p.id, p.complete]));

	const controllers = new Map<ProviderId, AbortController>();
	const abortAll = () => {
		for (const controller of controllers.values()) controller.abort();
	};

	const pending = new Map<ProviderId, Promise<RaceEvent>>();
	for (const provider of eligible) {
		const controller = new AbortController();
		controllers.set(provider.id, controller);
		const timer = setTimeout(
			() => controller.abort(),
			HARD_TIMEOUT_MS,
		);
		pending.set(
			provider.id,
			provider
				.fetchCast(vars, controller.signal)
				.then((result): RaceEvent => {
					clearTimeout(timer);
					// Central validation: downgrade mismatches to errors so an
					// off-target response can never win.
					if (
						result.kind === "found" &&
						!resolvesRequested(vars, result.cast)
					) {
						return {
							provider: provider.id,
							result: {
								kind: "error",
								provider: provider.id,
								message: "response does not resolve requested hash",
							},
						};
					}
					return { provider: provider.id, result };
				})
				.catch(
					(error): RaceEvent => ({
						provider: provider.id,
						result: { kind: "error", provider: provider.id, message: String(error) },
					}),
				),
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

	if (winner !== null) {
		return {
			kind: "found",
			cast: winner.cast,
			provider: winner.provider,
			partial: !winner.complete,
		};
	}
	if (completeMiss) return { kind: "not-found" };
	if (partial !== null) {
		return {
			kind: "found",
			cast: partial.cast,
			provider: partial.provider,
			partial: true,
		};
	}
	return { kind: "unreachable" };
}
