import { describe, expect, test } from "bun:test";

import type { Row } from "./ae-sql.ts";
import { aggregateRaceStats } from "./race-stats-aggregate.ts";

describe("aggregateRaceStats", () => {
	test("errorRate is errors over every consultation, and the window is the one asked for", async () => {
		const sql = async (query: string): Promise<Row[]> => {
			if (query.includes("index1")) {
				return [
					{ outcome: "shim", n: "8" },
					{ outcome: "not-found", n: "1" },
					{ outcome: "unreachable", n: "1" },
				];
			}
			if (query.includes("maxSampleInterval")) {
				return [
					{
						shim_found: "70",
						shim_miss: "10",
						shim_error: "20",
						shim_abort: "0",
						// Hyphenated ids alias to underscores — the SQL column
						// and the reader must agree, or this seat stays at 0.
						shim_potato_2_found: "9",
						shim_potato_2_error: "1",
						maxSampleInterval: "4",
					},
				];
			}
			expect(query).toContain("INTERVAL '6' HOUR");
			return [{ p50: "134.2", p95: "1100.4", samples: "90" }];
		};

		const snapshot = await aggregateRaceStats(sql, 6);
		const shim = snapshot.providers.find((p) => p.id === "shim");
		expect(snapshot.window).toEqual({ hours: 6 });
		expect(snapshot.sampled).toBe(true);
		expect(snapshot.outcomes).toEqual({
			found: 8,
			notFound: 1,
			unreachable: 1,
		});
		expect(shim).toMatchObject({
			requests: 100,
			errorRate: 0.2,
			p50Ms: 134,
			p95Ms: 1100,
			wins: 8,
		});
		expect(
			snapshot.providers.find((p) => p.id === "shim-potato-2"),
		).toMatchObject({ requests: 10, errorRate: 0.1 });
	});
});
