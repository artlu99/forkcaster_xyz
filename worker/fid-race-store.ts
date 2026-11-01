// Fid-race snapshot store: reads the "Author id races" snapshot from
// lmdis through a per-isolate TTL cache (contract in snapshot-store.ts).
// Transparency-route-only — the cast render path stays cache-free.

import {
	createSingletonSnapshotStore,
	createSnapshotStore,
} from "./snapshot-store.ts";
import type { FidSnapshot } from "../scripts/fid-race-lib.ts";

export type { FidSnapshot };

const KEY = "fid-race";

/** v/shape gate: an unrecognized snapshot is ignored (→ dashes), never half-parsed.
 * v2 is the open-vocabulary contract (fleet members join `sources` as they
 * appear); v1 predates per-member fleet ids and is ignored — re-run
 * `bun run stats:fid` to publish v2 (the 168h window re-reads fine). */
export function validateFidSnapshot(raw: unknown): FidSnapshot | null {
	if (raw === null || typeof raw !== "object") return null;
	const candidate = raw as {
		v?: unknown;
		sources?: Record<string, unknown>;
		legs?: unknown;
	};
	if (
		candidate.v !== 2 ||
		!candidate.sources ||
		typeof candidate.sources !== "object" ||
		!candidate.legs ||
		typeof candidate.legs !== "object"
	) {
		return null;
	}
	// Every source row must be a stats block with a numeric wins count —
	// anything else is a half-shape, not a vocabulary we know.
	for (const stats of Object.values(candidate.sources)) {
		if (
			stats === null ||
			typeof stats !== "object" ||
			typeof (stats as { wins?: unknown }).wins !== "number"
		) {
			return null;
		}
	}
	return raw as FidSnapshot;
}

export type FidRaceStore = { get(): Promise<FidSnapshot | null> };

type Deps = {
	url: string;
	token: string;
	/** Injectable clock for tests. */
	now?: () => number;
	/** Injectable transport for tests (default: global fetch + 2s cap). */
	fetchFn?: typeof fetch;
};

export function createFidRaceStore(deps: Deps): FidRaceStore {
	return createSnapshotStore<FidSnapshot>({
		key: KEY,
		validate: validateFidSnapshot,
		...deps,
	});
}

const singleton = createSingletonSnapshotStore<FidSnapshot>((url, token) =>
	createFidRaceStore({ url, token }),
);

export function getFidRaceSnapshot(
	env: Env | undefined,
): Promise<FidSnapshot | null> {
	return singleton.storeFor(env)?.get() ?? Promise.resolve(null);
}

/** Test seam: drop the per-isolate singleton between tests. */
export function resetFidRaceStore(): void {
	singleton.reset();
}
