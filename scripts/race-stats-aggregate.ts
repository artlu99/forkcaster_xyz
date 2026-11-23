// Race-stats aggregation — the query fan-out shared by the transparency
// publisher (168h) and the ntfy check (6h). No env, no publishing.

import { num, type Row } from "./ae-sql.ts";
import {
	buildLatencyQuery,
	buildOutcomesQuery,
	buildTalliesQuery,
	ROSTER,
	type Snapshot,
	tallyAlias,
} from "./race-stats-lib.ts";

export async function aggregateRaceStats(
	sql: (query: string) => Promise<Row[]>,
	hours: number,
): Promise<Snapshot> {
	const [outcomeRows, tallyRows] = await Promise.all([
		sql(buildOutcomesQuery(hours)),
		sql(buildTalliesQuery(hours)),
	]);

	const outcomes = new Map<string, number>();
	for (const row of outcomeRows) outcomes.set(String(row.outcome), num(row.n));
	const wins = (id: string): number => outcomes.get(id) ?? 0;

	const tallies = tallyRows[0] ?? {};
	const raced = (id: string, kind: string): number =>
		num(tallies[tallyAlias(id, kind)]);
	const maxSampleInterval = num(tallies.maxSampleInterval);

	const providers = await Promise.all(
		ROSTER.map(async (p) => {
			const [latencyRow] = await sql(buildLatencyQuery(p.id, hours));
			const requests =
				raced(p.id, "found") +
				raced(p.id, "miss") +
				raced(p.id, "error") +
				raced(p.id, "abort");
			const errors = raced(p.id, "error");
			const samples = num(latencyRow?.samples);
			return {
				id: p.id,
				role: p.role,
				wins: wins(p.id),
				requests,
				p50Ms: samples > 0 ? Math.round(num(latencyRow?.p50)) : null,
				p95Ms: samples > 0 ? Math.round(num(latencyRow?.p95)) : null,
				errorRate:
					requests > 0 ? Math.round((errors / requests) * 10000) / 10000 : 0,
			};
		}),
	);

	const found = providers.reduce((sum, p) => sum + p.wins, 0);
	return {
		v: 1,
		generatedAt: new Date().toISOString(),
		window: { hours },
		sampled: maxSampleInterval > 1,
		outcomes: {
			found,
			notFound: wins("not-found"),
			unreachable: wins("unreachable"),
		},
		providers,
	};
}
