// Breach lines for the ntfy check. Pure, so the wording stays fixture-tested
// and the script can query a short window without importing its own main.

import type { Snapshot } from "./race-stats-lib.ts";

export type AlertLimits = { p95Max: number; errMax: number };

export type KeyOutcome =
	| { kind: "ok"; generatedAt: string | null }
	| { kind: "bad"; reason: string };

/**
 * Dead-man's-switch lines for the published snapshots. A missing or
 * unreadable key is urgent; a key older than `staleHours` means the
 * publisher stopped. Fresh keys produce nothing.
 */
export function snapshotProblems(
	entries: ReadonlyArray<readonly [string, KeyOutcome]>,
	nowMs: number,
	staleHours: number,
): string[] {
	const problems: string[] = [];
	for (const [name, outcome] of entries) {
		if (outcome.kind === "bad") {
			problems.push(`${name}: unreadable (${outcome.reason})`);
			continue;
		}
		const generatedAt = outcome.generatedAt;
		const ageHours =
			generatedAt === null
				? Number.NaN
				: (nowMs - Date.parse(generatedAt)) / 3_600_000;
		if (!Number.isFinite(ageHours)) {
			problems.push(`${name}: unparseable generatedAt`);
		} else if (ageHours > staleHours) {
			problems.push(
				`${name}: stale — generatedAt ${generatedAt} (${Math.round(ageHours)}h old > ${staleHours}h)`,
			);
		}
	}
	return problems;
}

/** One line per provider over a limit. Zero-request rows are skipped. */
export function providerBreaches(
	providers: Snapshot["providers"],
	limits: AlertLimits,
): string[] {
	const lines: string[] = [];
	for (const p of providers) {
		if (p.requests <= 0) continue;
		const why: string[] = [];
		if (p.p95Ms !== null && p.p95Ms > limits.p95Max) {
			why.push(`p95 ${p.p95Ms}ms > ${limits.p95Max}ms`);
		}
		if (p.errorRate > limits.errMax) {
			why.push(
				`err ${(p.errorRate * 100).toFixed(2)}% > ${(limits.errMax * 100).toFixed(1)}%`,
			);
		}
		if (why.length > 0) lines.push(`${p.id}: ${why.join(", ")}`);
	}
	return lines;
}
