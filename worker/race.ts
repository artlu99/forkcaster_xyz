// Hedged fleet racing — the shared N-leg machinery under both shim-level
// reads (raceShimProbe) and the cast provider race (raceCast).
//
// The model: no single host is the source of truth. Legs are asked in a
// staggered order — a tiny random step per leg, so replicas don't slam in
// sync and a fast answer cancels the stragglers before they're queried —
// and the verdict is collective:
//
// - the FIRST affirmative (found) answer wins outright;
// - a consulted miss (asked, no data) is a VOTE: not-found settles only
//   when every leg has missed — a pending leg can always rescue a miss
//   that already landed;
// - errors never decide: they surface only when every leg errored (the
//   primary leg's error, for message stability).
//
// The price is deliberate: a true miss resolves as fast as the SLOWEST
// leg, not the fastest. That is what "soften the SPOF" costs.

/** One leg's terminal state. `fallback` replays the primary leg's own
 * single-source answer when the primary is among the missing/errored —
 * the mechanism that keeps per-endpoint verdict contracts byte-compatible
 * under the race. */
export type RaceLeg<T> =
	| { kind: "found"; value: T }
	| { kind: "miss"; fallback?: T }
	| { kind: "error"; error?: unknown; fallback?: T };

/** Stagger step range (ms): leg i starts ~i random steps after leg 0. */
export const STAGGER_STEP_MIN_MS = 25;
export const STAGGER_STEP_MAX_MS = 90;

/**
 * Cumulative staggered start delays: leg 0 at 0ms, leg i one random step
 * in [min, max] per index further out. Monotonic, tiny, and non-
 * synchronized across requests — the jitter defuses herd alignment (all
 * visitors hitting leg k at the same instant).
 */
export function staggerDelays(
	count: number,
	minMs = STAGGER_STEP_MIN_MS,
	maxMs = STAGGER_STEP_MAX_MS,
): number[] {
	const delays: number[] = [];
	let at = 0;
	for (let i = 0; i < count; i++) {
		delays.push(at);
		at += minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
	}
	return delays;
}

/**
 * The collective verdict over settled terminals (index-aligned with the
 * legs; unset entries are legs that never settled). First found wins;
 * a miss beats errors (the network was asked); all-errored surfaces the
 * PRIMARY leg's error. The primary's miss fallback replays when the
 * primary itself missed — byte-compat with the pre-fleet answers.
 */
export function collectTerminals<T>(
	primary: number,
	terminals: Array<RaceLeg<T> | undefined>,
): RaceLeg<T> {
	const firstFound = terminals.find((t) => t?.kind === "found");
	if (firstFound) return firstFound;
	const firstMiss = terminals.find(
		(t): t is RaceLeg<T> & { kind: "miss" } => t?.kind === "miss",
	);
	if (firstMiss) {
		const primaryTerminal = terminals[primary];
		const fallback =
			primaryTerminal?.kind === "miss"
				? primaryTerminal.fallback
				: firstMiss.fallback;
		return { kind: "miss", fallback };
	}
	const primaryTerminal = terminals[primary];
	if (primaryTerminal?.kind === "error") return primaryTerminal;
	const firstError = terminals.find((t) => t?.kind === "error");
	if (firstError) return firstError;
	// No settled terminal at all — nothing was consulted.
	return { kind: "miss", fallback: undefined };
}

/**
 * Run N legs under collective verdicts with staggered starts. Legs are
 * thunks (so a not-yet-started leg costs nothing); leg i starts after
 * `delays[i]` ms (default `staggerDelays(legs.length)`). A found settles
 * the race immediately and cancels starts that haven't fired; otherwise
 * the race settles when every leg has, via `collectTerminals` with leg 0
 * as the primary. Legs own their own timeouts — the race never abandons
 * a started leg, it only decides early.
 */
export function collectiveRace<T>(opts: {
	legs: Array<() => Promise<RaceLeg<T>>>;
	delays?: number[];
}): Promise<RaceLeg<T>> {
	const { legs, delays = staggerDelays(legs.length) } = opts;
	return new Promise<RaceLeg<T>>((resolve) => {
		const terminals: Array<RaceLeg<T> | undefined> = new Array(legs.length);
		let unsettled = legs.length;
		let done = false;
		const timers: ReturnType<typeof setTimeout>[] = [];
		const settle = (r: RaceLeg<T>) => {
			if (done) return;
			done = true;
			for (const t of timers) clearTimeout(t);
			resolve(r);
		};
		const onTerminal = (index: number, r: RaceLeg<T>) => {
			if (done) return;
			terminals[index] = r;
			if (r.kind === "found") return settle(r);
			unsettled -= 1;
			if (unsettled === 0) settle(collectTerminals(0, terminals));
		};
		legs.forEach((leg, index) => {
			const start = () => {
				if (done) return; // the race resolved before this leg fired
				leg().then(
					(r) => onTerminal(index, r),
					(error) =>
						onTerminal(index, { kind: "error", error, fallback: undefined }),
				);
			};
			const delay = delays[index] ?? 0;
			if (delay <= 0) start();
			else timers.push(setTimeout(start, delay));
		});
	});
}
