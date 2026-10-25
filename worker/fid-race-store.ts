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

/** v/shape gate: an unrecognized snapshot is ignored (→ dashes), never half-parsed. */
export function validateFidSnapshot(raw: unknown): FidSnapshot | null {
	if (raw === null || typeof raw !== "object") return null;
	const candidate = raw as {
		v?: unknown;
		sources?: Record<string, unknown>;
		legs?: unknown;
	};
	if (
		candidate.v !== 1 ||
		!candidate.sources ||
		!candidate.legs ||
		// All three sources must be present — a pre-per-node snapshot
		// (shim/node keys only) predates the contract and is ignored.
		candidate.sources.shim === undefined ||
		candidate.sources.haatz === undefined ||
		candidate.sources.snap === undefined
	) {
		return null;
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
