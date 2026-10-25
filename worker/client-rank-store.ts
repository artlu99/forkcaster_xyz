// Client-rank snapshot store: reads the rank snapshot from lmdis through
// a per-isolate TTL cache (contract in snapshot-store.ts; silent-degrade
// to null ⇒ the registry default pill order).
//
// The cast render path reads through getRankSnapshotSoon(), which races
// the store against a short cap: a cold refresh must never stall a cast
// page (the store's own 2s lmdis cap exists for /transparency, where a
// slower table is fine). After the first successful fetch the per-isolate
// TTL makes the cast-path read instantaneous.

import {
	createSingletonSnapshotStore,
	createSnapshotStore,
	snapshotSoon,
} from "./snapshot-store.ts";
import type { RankSnapshot } from "../scripts/client-rank-lib.ts";

export type { RankSnapshot };

const KEY = "client-rank";

/** v/shape gate: an unrecognized snapshot is ignored, never half-parsed. */
export function validateRankSnapshot(raw: unknown): RankSnapshot | null {
	if (raw === null || typeof raw !== "object") return null;
	const candidate = raw as { v?: unknown; rows?: unknown };
	if (candidate.v !== 1 || !Array.isArray(candidate.rows)) return null;
	return raw as RankSnapshot;
}

export type ClientRankStore = { get(): Promise<RankSnapshot | null> };

type Deps = {
	url: string;
	token: string;
	/** Injectable clock for tests. */
	now?: () => number;
	/** Injectable transport for tests (default: global fetch + 2s cap). */
	fetchFn?: typeof fetch;
};

export function createClientRankStore(deps: Deps): ClientRankStore {
	return createSnapshotStore<RankSnapshot>({
		key: KEY,
		validate: validateRankSnapshot,
		...deps,
	});
}

const singleton = createSingletonSnapshotStore<RankSnapshot>((url, token) =>
	createClientRankStore({ url, token }),
);

/** Full-cap read (2s worst case) — /transparency and the JSON twin. */
export function getRankSnapshot(
	env: Env | undefined,
): Promise<RankSnapshot | null> {
	return singleton.storeFor(env)?.get() ?? Promise.resolve(null);
}

/**
 * Cast-path read: resolves null if the rank isn't available within
 * `maxWaitMs` — the pill order stays registry-ordered instead of stalling
 * the render.
 */
export function getRankSnapshotSoon(
	env: Env | undefined,
	maxWaitMs: number,
): Promise<RankSnapshot | null> {
	return snapshotSoon(singleton.storeFor(env), maxWaitMs);
}

/** Test seam: drop the per-isolate singleton between tests. */
export function resetClientRankStore(): void {
	singleton.reset();
}
