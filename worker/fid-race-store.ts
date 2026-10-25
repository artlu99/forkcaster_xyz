// Fid-race snapshot store: reads the "Author id races" snapshot from
// lmdis through a per-isolate TTL cache. Transparency-route-only — the
// cast render path stays cache-free.
//
// Line-for-line mirror of race-stats-store.ts (see the rationale there):
// missing key, unrecognizable shape, 2s timeout, or lmdis unreachable all
// resolve to null → "coming soon"; last-good serves ≤24h; failures back
// off to once per 60s.

import { LmdisClient } from "./vendor/lmdis-sdk.ts";
import type { FidSnapshot } from "../scripts/fid-race-lib.ts";

export type { FidSnapshot };

const TTL_MS = 10 * 60_000; // refresh cadence while healthy
const RETRY_MS = 60_000; // backoff between attempts after a failure
const MAX_STALE_MS = 24 * 60 * 60_000; // last-good serving window
const TIMEOUT_MS = 2000;
const KEY = "fid-race";

export type FidRaceStore = { get(): Promise<FidSnapshot | null> };

type Deps = {
	url: string;
	token: string;
	/** Injectable clock for tests. */
	now?: () => number;
	/** Injectable transport for tests (default: global fetch + 2s cap). */
	fetchFn?: typeof fetch;
};

/** v/shape gate: an unrecognized snapshot is ignored (→ dashes), never half-parsed. */
export function validateFidSnapshot(raw: unknown): FidSnapshot | null {
	if (raw === null || typeof raw !== "object") return null;
	const candidate = raw as {
		v?: unknown;
		sources?: unknown;
		legs?: unknown;
	};
	if (candidate.v !== 1 || !candidate.sources || !candidate.legs) return null;
	return raw as FidSnapshot;
}

export function createFidRaceStore(deps: Deps): FidRaceStore {
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

	let value: FidSnapshot | null = null;
	let fetchedAt = 0; // last successful fetch
	let attemptedAt = -RETRY_MS; // last attempt — negative so the first get always attempts
	let inflight: Promise<FidSnapshot | null> | undefined;

	const refresh = async (): Promise<FidSnapshot | null> => {
		attemptedAt = now();
		try {
			const raw = await client.get<unknown>(KEY);
			// A missing key is authoritative (snapshot removed) — same as an
			// unrecognized shape: no snapshot. Dashes.
			value = validateFidSnapshot(raw);
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
		get(): Promise<FidSnapshot | null> {
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

let singleton: { key: string; store: FidRaceStore } | undefined;

export function getFidRaceSnapshot(env: Env | undefined): Promise<FidSnapshot | null> {
	const url = env?.LMDIS_URL ?? "";
	const token = env?.LMDIS_REST_TOKEN ?? "";
	if (url === "" || token === "") return Promise.resolve(null);
	const key = `${url}|${token.length}`;
	if (singleton === undefined || singleton.key !== key) {
		singleton = { key, store: createFidRaceStore({ url, token }) };
	}
	return singleton.store.get();
}

/** Test seam: drop the per-isolate singleton between tests. */
export function resetFidRaceStore(): void {
	singleton = undefined;
}
