// Snapshot store: THE lmdis-backed TTL cache behind every /transparency
// tracker (race-stats, client-rank, fid-race) — one implementation of the
// TTL / failure-backoff / stale-while-error / single-flight contract the
// per-tracker modules used to mirror by hand.
//
// Silent-degrade contract: missing key, unrecognizable shape, 2s timeout,
// or lmdis unreachable all resolve to null. A last good snapshot keeps
// serving for ≤24h while lmdis is unreachable; refresh attempts back off
// to once per 60s on failure, so a down lmdis sees ~1 request/minute per
// isolate at worst, and a healthy one ~1 read / 10 min per isolate.
//
// Reads go through the vendored lmdis SDK (Upstash-shaped seam); the 2s
// cap rides on the injected fetch — an LMDB GET is sub-ms server-side,
// so 2s means "down".

import { LmdisClient } from "./vendor/lmdis-sdk.ts";

export const SNAPSHOT_TTL_MS = 10 * 60_000; // refresh cadence while healthy
export const SNAPSHOT_RETRY_MS = 60_000; // backoff between attempts after a failure
export const SNAPSHOT_MAX_STALE_MS = 24 * 60 * 60_000; // last-good serving window
export const SNAPSHOT_TIMEOUT_MS = 2000;

export type SnapshotStore<T> = { get(): Promise<T | null> };

export type SnapshotStoreDeps<T> = {
	/** lmdis key — one store per tracker. */
	key: string;
	/** v/shape gate: an unrecognized snapshot is ignored, never half-parsed. */
	validate: (raw: unknown) => T | null;
	url: string;
	token: string;
	/** Injectable clock for tests. */
	now?: () => number;
	/** Injectable transport for tests (default: global fetch + 2s cap). */
	fetchFn?: typeof fetch;
};

export function createSnapshotStore<T>(
	deps: SnapshotStoreDeps<T>,
): SnapshotStore<T> {
	const now = deps.now ?? Date.now;
	const transport: typeof fetch =
		deps.fetchFn ??
		((input, init) =>
			fetch(input, {
				...init,
				signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
			}));
	const client = new LmdisClient({
		url: deps.url,
		token: deps.token,
		fetch: transport,
	});

	let value: T | null = null;
	let fetchedAt = 0; // last successful fetch
	let attemptedAt = -SNAPSHOT_RETRY_MS; // negative so the first get always attempts
	let inflight: Promise<T | null> | undefined;

	const refresh = async (): Promise<T | null> => {
		attemptedAt = now();
		try {
			const raw = await client.get<unknown>(deps.key);
			// A missing key is authoritative (snapshot removed) — same as an
			// unrecognized shape: no snapshot.
			value = deps.validate(raw);
			fetchedAt = now();
		} catch {
			// Unreachable/timeout: keep serving the last good value while it
			// is within the stale window; past it, stop serving and keep
			// retrying on the backoff.
			if (value !== null && now() - fetchedAt > SNAPSHOT_MAX_STALE_MS) {
				value = null;
			}
		}
		return value;
	};

	return {
		get(): Promise<T | null> {
			const t = now();
			if (value !== null && t - fetchedAt < SNAPSHOT_TTL_MS) {
				return Promise.resolve(value);
			}
			if (t - attemptedAt < SNAPSHOT_RETRY_MS && inflight === undefined) {
				return Promise.resolve(
					value !== null && t - fetchedAt < SNAPSHOT_MAX_STALE_MS
						? value
						: null,
				);
			}
			// Join an in-flight refresh instead of double-fetching (or answering
			// from the backoff branch while a refresh is already running).
			inflight ??= refresh().finally(() => {
				inflight = undefined;
			});
			return inflight;
		},
	};
}

/**
 * Per-isolate singleton, keyed on the lmdis credentials: each tracker
 * module calls this once and destructures `{ storeFor, reset }` — the
 * full-cap getter and the test seam that drops the captured singleton.
 * `storeFor` returns null when the env carries no lmdis.
 */
export function createSingletonSnapshotStore<T>(
	create: (url: string, token: string) => SnapshotStore<T>,
): {
	storeFor: (env: Env | undefined) => SnapshotStore<T> | null;
	reset: () => void;
} {
	let singleton: { key: string; store: SnapshotStore<T> } | undefined;
	return {
		storeFor(env: Env | undefined): SnapshotStore<T> | null {
			const url = env?.LMDIS_URL ?? "";
			const token = env?.LMDIS_REST_TOKEN ?? "";
			if (url === "" || token === "") return null;
			const key = `${url}|${token.length}`;
			if (singleton === undefined || singleton.key !== key) {
				singleton = { key, store: create(url, token) };
			}
			return singleton.store;
		},
		reset(): void {
			singleton = undefined;
		},
	};
}

/**
 * Capped read for render paths that must not stall: resolves null if the
 * snapshot isn't available within `maxWaitMs`. Warm TTL hits resolve
 * immediately; the race only ever waits on a cold refresh.
 */
export async function snapshotSoon<T>(
	store: SnapshotStore<T> | null,
	maxWaitMs: number,
): Promise<T | null> {
	if (store === null) return null;
	return Promise.race([
		store.get(),
		new Promise<null>((resolve) => setTimeout(() => resolve(null), maxWaitMs)),
	]);
}
