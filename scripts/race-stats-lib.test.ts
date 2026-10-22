/**
 * Fixture tests for the race-stats SQL builders: the dialect bets are
 * live-verified (scripts/probe/ae.ts), and these tests pin the verified
 * shapes so a careless edit can't reintroduce an unsupported construct
 * (the dialect rejects CONCAT and *OrZero conversions outright).
 */
import { describe, expect, test } from "bun:test";

import {
	buildLatencyQuery,
	buildOutcomesQuery,
	buildTalliesQuery,
	msExpr,
	ROSTER,
} from "./race-stats-lib.ts";

describe("buildTalliesQuery", () => {
	test("covers every provider × kind with position needles", () => {
		const q = buildTalliesQuery(168);
		for (const p of ROSTER) {
			for (const kind of ["found", "miss", "error", "abort"]) {
				expect(q).toContain(`position('${p.id}:${kind}:' IN blob1) > 0`);
			}
		}
	});

	test("aliases are identifier-safe and the sampling ceiling is selected", () => {
		const q = buildTalliesQuery(168);
		expect(q).toContain("max(_sample_interval) AS maxSampleInterval");
		expect(q).toContain("farcaster_tv_found");
		expect(q).not.toContain("farcaster-tv_");
	});

	test("window uses the parameterized hour interval", () => {
		expect(buildTalliesQuery(24)).toContain("INTERVAL '24' HOUR");
	});
});

describe("buildOutcomesQuery", () => {
	test("groups weighted rows by index1", () => {
		const q = buildOutcomesQuery(168);
		expect(q).toContain("index1 AS outcome");
		expect(q).toContain("sum(_sample_interval) AS n");
		expect(q).toContain("GROUP BY outcome");
	});
});

describe("buildLatencyQuery + msExpr", () => {
	test("filters to the provider and uses the verified extraction pipeline", () => {
		const q = buildLatencyQuery("shim", 168);
		expect(q).toContain("position('shim:' IN blob1) > 0");
		expect(q).toContain("quantileExactWeighted(0.5)");
		expect(q).toContain("quantileExactWeighted(0.95)");
		expect(q).toContain("sum(_sample_interval) AS samples");
	});

	test("extraction uses only live-verified functions", () => {
		const expr = msExpr("farcaster-tv");
		expect(expr).toContain("position('farcaster-tv:' IN blob1)");
		expect(expr).toContain("format('{},'");
		expect(expr).toContain("toUInt32(");
		// The dialect rejects these outright — keep them out forever.
		expect(expr.toUpperCase()).not.toContain("CONCAT");
		expect(expr.toUpperCase()).not.toContain("ORZERO");
	});
});
