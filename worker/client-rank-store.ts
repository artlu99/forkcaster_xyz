// Client-rank snapshot store: reads the rank snapshot from lmdis through
// a per-isolate TTL cache. Mirrors race-stats-store.ts (same TTL/backoff/
// stale/timeout contract, different key); silent-degrade to null ⇒ the
// registry default pill order.
//
// The cast render path reads through getRankSnapshotSoon(), which races
// the store against a short cap: a cold refresh must never stall a cast
// page (the store's own 2s lmdis cap exists for /transparency, where a
// slower table is fine). After the first successful fetch the per-isolate
// TTL makes the cast-path read instantaneous.

import { LmdisClient } from "./vendor/lmdis-sdk.ts";
import type { RankSnapshot } from "../scripts/client-rank-lib.ts";

export type { RankSnapshot };

const TTL_MS = 10 * 60_000; // refresh cadence while healthy
const RETRY_MS = 60_000; // backoff between attempts after a failure
const MAX_STALE_MS = 24 * 60 * 60_000; // last-good serving window
const TIMEOUT_MS = 2000;
const KEY = "client-rank";

export type ClientRankStore = { get(): Promise<RankSnapshot | null> };

type Deps = {
	url: string;
	token: string;
	/** Injectable clock for tests. */
	now?: () => number;
	/** Injectable transport for tests (default: global fetch + 2s cap). */
	fetchFn?: typeof fetch;
};

/** v/shape gate: an unrecognized snapshot is ignored, never half-parsed. */
export function validateRankSnapshot(raw: unknown): RankSnapshot | null {
	if (raw === null || typeof raw !== "object") return null;
	const candidate = raw as { v?: unknown; rows?: unknown };
	if (candidate.v !== 1 || !Array.isArray(candidate.rows)) return null;
	return raw as RankSnapshot;
}

export function createClientRankStore(deps: Deps): ClientRankStore {
	const now = deps.now ?? Date.now;
	const transport: typeof fetch =
		deps.fetchFn ??
		((input, init) =>
			fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }));
	const client = new LmdisClient({
		url: deps.url,
		token: deps.token,
		fetch: transport,
	});

	let value: RankSnapshot | null = null;
	let fetchedAt = 0; // last successful fetch
	let attemptedAt = -RETRY_MS; // negative so the first get always attempts
	let inflight: Promise<RankSnapshot | null> | undefined;

	const refresh = async (): Promise<RankSnapshot | null> => {
		attemptedAt = now();
		try {
			const raw = await client.get<unknown>(KEY);
			// A missing key is authoritative (snapshot removed) — no rank,
			// registry order. Same contract as the race store.
			value = validateRankSnapshot(raw);
			fetchedAt = now();
		} catch {
			// Unreachable/timeout: keep serving the last good value while it
			// is within the stale window; past it, stop (registry order).
			if (value !== null && now() - fetchedAt > MAX_STALE_MS) {
				value = null;
			}
		}
		return value;
	};

	return {
		get(): Promise<RankSnapshot | null> {
			const t = now();
			if (value !== null && t - fetchedAt < TTL_MS) {
				return Promise.resolve(value);
			}
			if (t - attemptedAt < RETRY_MS && inflight === undefined) {
				return Promise.resolve(
					value !== null && t - fetchedAt < MAX_STALE_MS ? value : null,
				);
			}
			inflight ??= refresh().finally(() => {
				inflight = undefined;
			});
			return inflight;
		},
	};
}

// --- per-isolate singleton ---

let singleton: { key: string; store: ClientRankStore } | undefined;

function rankStore(env: Env | undefined): ClientRankStore | null {
	const url = env?.LMDIS_URL ?? "";
	const token = env?.LMDIS_REST_TOKEN ?? "";
	if (url === "" || token === "") return null;
	const key = `${url}|${token.length}`;
	if (singleton === undefined || singleton.key !== key) {
		singleton = { key, store: createClientRankStore({ url, token }) };
	}
	return singleton.store;
}

/** Full-cap read (2s worst case) — /transparency and the JSON twin. */
export function getRankSnapshot(env: Env | undefined): Promise<RankSnapshot | null> {
	const store = rankStore(env);
	if (store === null) return Promise.resolve(null);
	return store.get();
}

/**
 * Cast-path read: resolves null if the rank isn't available within
 * `maxWaitMs` — the pill order stays registry-ordered instead of stalling
 * the render. Warm TTL hits resolve immediately; the race only ever waits
 * on a cold refresh.
 */
export async function getRankSnapshotSoon(
	env: Env | undefined,
	maxWaitMs: number,
): Promise<RankSnapshot | null> {
	const store = rankStore(env);
	if (store === null) return null;
	return Promise.race([
		store.get(),
		new Promise<null>((resolve) => setTimeout(() => resolve(null), maxWaitMs)),
	]);
}

/** Test seam: drop the per-isolate singleton between tests. */
export function resetClientRankStore(): void {
	singleton = undefined;
}
