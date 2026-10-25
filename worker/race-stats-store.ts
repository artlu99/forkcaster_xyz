// Race-stats snapshot store: reads the transparency snapshot from lmdis
// through a per-isolate TTL cache. Transparency-route-only — the cast
// render path stays cache-free. The caching contract lives in
// snapshot-store.ts; this module is the tracker's key, shape gate, and
// singleton wiring. Silent-degrade: missing key/unknown shape/unreachable
// ⇒ null ⇒ "coming soon" dashes (see README "Race stats (/transparency)").

import {
	createSingletonSnapshotStore,
	createSnapshotStore,
} from "./snapshot-store.ts";
import type { Snapshot } from "../scripts/race-stats-lib.ts";

export type { Snapshot };

const KEY = "race-stats";

/** v/shape gate: an unrecognized snapshot is ignored (→ dashes), never half-parsed. */
export function validateSnapshot(raw: unknown): Snapshot | null {
	if (raw === null || typeof raw !== "object") return null;
	const candidate = raw as { v?: unknown; providers?: unknown };
	if (candidate.v !== 1 || !Array.isArray(candidate.providers)) return null;
	return raw as Snapshot;
}

export type RaceStatsStore = { get(): Promise<Snapshot | null> };

type Deps = {
	url: string;
	token: string;
	/** Injectable clock for tests. */
	now?: () => number;
	/** Injectable transport for tests (default: global fetch + 2s cap). */
	fetchFn?: typeof fetch;
};

export function createRaceStatsStore(deps: Deps): RaceStatsStore {
	return createSnapshotStore<Snapshot>({
		key: KEY,
		validate: validateSnapshot,
		...deps,
	});
}

const singleton = createSingletonSnapshotStore<Snapshot>((url, token) =>
	createRaceStatsStore({ url, token }),
);

export function getRaceStatsSnapshot(
	env: Env | undefined,
): Promise<Snapshot | null> {
	return singleton.storeFor(env)?.get() ?? Promise.resolve(null);
}

/** Test seam: drop the per-isolate singleton between tests. */
export function resetRaceStatsStore(): void {
	singleton.reset();
}
