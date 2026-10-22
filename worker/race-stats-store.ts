// Race-stats snapshot store: reads the transparency snapshot from lmdis
// through a per-isolate TTL cache. Transparency-route-only — the cast
// render path stays cache-free.
//
// Silent-degrade contract (see README "Race stats (/transparency)"): missing key, unrecognizable shape,
// 2s timeout, or lmdis unreachable all resolve to null → the "coming
// soon" dashes. A last good snapshot keeps serving for ≤24h while lmdis
// is unreachable; refresh attempts back off to once per 60s on failure,
// so a down lmdis sees ~1 request/minute per isolate at worst, and a
// healthy one ~1 read / 10 min per isolate.
//
// Reads go through the vendored lmdis SDK (Upstash-shaped seam); the 2s
// cap rides on the injected fetch — an LMDB GET is sub-ms server-side,
// so 2s means "down".

import { LmdisClient } from "./vendor/lmdis-sdk.ts";
import type { Snapshot } from "../scripts/race-stats-lib.ts";

export type { Snapshot };

const TTL_MS = 10 * 60_000; // refresh cadence while healthy
const RETRY_MS = 60_000; // backoff between attempts after a failure
const MAX_STALE_MS = 24 * 60 * 60_000; // last-good serving window
const TIMEOUT_MS = 2000;
const KEY = "race-stats";

export type RaceStatsStore = { get(): Promise<Snapshot | null> };

type Deps = {
	url: string;
	token: string;
	/** Injectable clock for tests. */
	now?: () => number;
	/** Injectable transport for tests (default: global fetch + 2s cap). */
	fetchFn?: typeof fetch;
};

/** v/shape gate: an unrecognized snapshot is ignored (→ dashes), never half-parsed. */
export function validateSnapshot(raw: unknown): Snapshot | null {
	if (raw === null || typeof raw !== "object") return null;
	const candidate = raw as { v?: unknown; providers?: unknown };
	if (candidate.v !== 1 || !Array.isArray(candidate.providers)) return null;
	return raw as Snapshot;
}

export function createRaceStatsStore(deps: Deps): RaceStatsStore {
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

	let value: Snapshot | null = null;
	let fetchedAt = 0; // last successful fetch
	let attemptedAt = -RETRY_MS; // last attempt — negative so the first get always attempts
	let inflight: Promise<Snapshot | null> | undefined;

	const refresh = async (): Promise<Snapshot | null> => {
		attemptedAt = now();
		try {
			const raw = await client.get<unknown>(KEY);
			// A missing key is authoritative (snapshot removed) — same as an
			// unrecognized shape: no snapshot. Dashes.
			value = validateSnapshot(raw);
			fetchedAt = now();
		} catch {
			// Unreachable/timeout: keep serving the last good value while it
			// is within the stale window; past it, stop serving (dashes) and
			// keep retrying on the backoff.
			if (value !== null && now() - fetchedAt > MAX_STALE_MS) {
				value = null;
			}
		}
		return value;
	};

	return {
		get(): Promise<Snapshot | null> {
			const t = now();
			if (value !== null && t - fetchedAt < TTL_MS) {
				return Promise.resolve(value);
			}
			if (t - attemptedAt < RETRY_MS && inflight === undefined) {
				return Promise.resolve(
					value !== null && t - fetchedAt < MAX_STALE_MS ? value : null,
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

// --- per-isolate singleton ---

let singleton: { key: string; store: RaceStatsStore } | undefined;

export function getRaceStatsSnapshot(env: Env | undefined): Promise<Snapshot | null> {
	const url = env?.LMDIS_URL ?? "";
	const token = env?.LMDIS_REST_TOKEN ?? "";
	if (url === "" || token === "") return Promise.resolve(null);
	const key = `${url}|${token.length}`;
	if (singleton === undefined || singleton.key !== key) {
		singleton = { key, store: createRaceStatsStore({ url, token }) };
	}
	return singleton.store.get();
}

/** Test seam: drop the per-isolate singleton between tests. */
export function resetRaceStatsStore(): void {
	singleton = undefined;
}
