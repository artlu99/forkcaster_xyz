/**
 * Transparency page tests: the racing-stats table fills from the snapshot
 * and degrades to "coming soon" dashes when it's absent — on both the
 * HTML page and the JSON twin. The Domains section carries static
 * registration facts (expiry + RDAP confirm links) on both variants.
 */
import { expect, mock, test } from "bun:test";
import { CLIENTS } from "./client-registry.ts";

mock.module("server-only", () => ({}));
// CJS deps (linkify-react) call require("react"); sync preact/compat works.
mock.module("react", () => require("preact/compat"));
mock.module("react-dom", () => require("preact/compat"));
mock.module("react/jsx-runtime", () => require("preact/jsx-runtime"));
mock.module("react/jsx-dev-runtime", () => require("preact/jsx-runtime"));

const { renderTransparencyHtml, transparencyJson } = await import(
	"./transparency.tsx"
);
type Snapshot = Parameters<typeof renderTransparencyHtml>[0] extends {
	snapshot?: infer S;
}
	? NonNullable<S>
	: never;

const SNAPSHOT: Snapshot = {
	v: 1,
	generatedAt: "2026-10-21T23:24:55.953Z",
	window: { hours: 168 },
	sampled: false,
	outcomes: { found: 101, notFound: 1, unreachable: 0 },
	providers: [
		{
			id: "shim",
			role: "complete",
			wins: 18,
			requests: 102,
			p50Ms: 700,
			p95Ms: 701,
			errorRate: 0.8137,
		},
		{
			id: "farcaster-tv",
			role: "partial",
			wins: 82,
			requests: 101,
			p50Ms: 129,
			p95Ms: 338,
			errorRate: 0,
		},
	],
};

test("HTML with a snapshot: numbers fill the table, dashes only for missing providers", () => {
	const html = renderTransparencyHtml({ snapshot: SNAPSHOT });
	expect(html).toContain("<td>18</td>");
	expect(html).toContain("700ms");
	expect(html).toContain("129ms");
	expect(html).toContain("81%");
	expect(html).toContain("stats as of");
	expect(html).toContain("window 168h");
	// haatz/snap aren't in this snapshot — their rows keep the dashes.
	expect(html).toContain("<td>—</td>");
});

test("HTML without a snapshot: the coming-soon dashes remain, no as-of line", () => {
	const html = renderTransparencyHtml({});
	expect(html).not.toContain("stats as of");
	expect(html).toContain("<td>—</td>");
	expect(html).toContain("<td>shim</td>");
});

test("JSON twin with a snapshot: live status with real numbers", () => {
	const json = transparencyJson(SNAPSHOT) as {
		racingStats: {
			status: string;
			generatedAt?: string;
			providers: Array<{ id: string; wins: number | null }>;
		};
	};
	expect(json.racingStats.status).toBe("live");
	expect(json.racingStats.generatedAt).toBe(SNAPSHOT.generatedAt);
	const shim = json.racingStats.providers.find((p) => p.id === "shim");
	expect(shim?.wins).toBe(18);
});

test("JSON twin without a snapshot: coming-soon with nulls", () => {
	const json = transparencyJson() as {
		racingStats: {
			status: string;
			window: null;
			providers: Array<{ id: string; wins: number | null }>;
		};
	};
	expect(json.racingStats.status).toBe("coming-soon");
	expect(json.racingStats.window).toBeNull();
	const shim = json.racingStats.providers.find((p) => p.id === "shim");
	expect(shim?.wins).toBeNull();
});

test("Domains section: expiry dates + RDAP confirm links on HTML and JSON twin", () => {
	const html = renderTransparencyHtml({ snapshot: SNAPSHOT });
	expect(html).toContain(
		"<code>forkcaster.xyz</code> — canonical · expires 2027-10-20",
	);
	expect(html).toContain(
		"<code>warpcats.com</code> — same pages · expires 2027-10-21",
	);
	expect(html).toContain(
		'href="https://rdap.centralnic.com/xyz/domain/forkcaster.xyz"',
	);
	expect(html).toContain(
		'href="https://rdap.verisign.com/com/v1/domain/warpcats.com"',
	);
	expect(html).toContain("Checked 2026-10-22");

	const json = transparencyJson(SNAPSHOT) as {
		domains: {
			canonical: string;
			also: string[];
			checked: string;
			registrations: Array<{
				name: string;
				role: string;
				registrar: string;
				registered: string;
				expires: string;
				rdap: string;
			}>;
		};
	};
	// Pre-existing keys stay untouched for current consumers.
	expect(json.domains.canonical).toBe("https://forkcaster.xyz");
	expect(json.domains.also).toEqual(["https://warpcats.com"]);
	expect(json.domains.checked).toBe("2026-10-22");
	expect(json.domains.registrations).toHaveLength(2);
	const xyz = json.domains.registrations.find(
		(d) => d.name === "forkcaster.xyz",
	);
	expect(xyz?.role).toBe("canonical");
	expect(xyz?.registrar).toBe("Cloudflare, Inc.");
	expect(xyz?.registered).toBe("2026-10-20");
	expect(xyz?.expires).toBe("2027-10-20");
	expect(xyz?.rdap).toBe(
		"https://rdap.centralnic.com/xyz/domain/forkcaster.xyz",
	);
	const com = json.domains.registrations.find(
		(d) => d.name === "warpcats.com",
	);
	expect(com?.role).toBe("alias");
	expect(com?.expires).toBe("2027-10-21");
	expect(com?.rdap).toBe("https://rdap.verisign.com/com/v1/domain/warpcats.com");
});

// --- client rank (PLAN3) ---

const RANK: import("./client-rank-store.ts").RankSnapshot = {
	v: 1,
	generatedAt: "2026-10-23T00:00:00.000Z",
	window: { hours: 168 },
	sampled: false,
	total: 250,
	warmingUp: false,
	rows: [
		{
			id: "firefly",
			first: 10,
			switched: 2,
			repeat: 5,
			pill: 17,
			goNow: 3,
			auto: 20,
			score: 21.4,
			share: 60.1,
		},
		{
			id: "farcaster",
			first: 1,
			switched: 0,
			repeat: 1,
			pill: 2,
			goNow: 0,
			auto: 4,
			score: 1.7,
			share: 4.8,
		},
	],
};

test("rank table: numbers fill the roster, absent clients keep dashes", () => {
	const html = renderTransparencyHtml({ snapshot: SNAPSHOT, rank: RANK });
	expect(html).toContain("Client choices");
	expect(html).toContain("<td>firefly</td>");
	expect(html).toContain("<td>21.4</td>");
	expect(html).toContain("<td>60.1%</td>");
	// Every active client renders a row — reordered stats never hide anyone.
	expect(html).toContain("<td>quorum</td>");
	// The weighting is published next to the numbers (the methodology is
	// part of the public contract).
	expect(html).toContain("auto-opens ×0.1");
	expect(html).toContain("pill order follows this table");
	expect(html).toContain("rank stats as of");
});

test("rank table: warming up — counts stay, shares are withheld", () => {
	const warming = {
		...RANK,
		total: 42,
		warmingUp: true,
		rows: RANK.rows.map((r) => ({ ...r, share: null })),
	};
	const html = renderTransparencyHtml({ rank: warming });
	expect(html).toContain("<td>21.4</td>"); // counts shown
	expect(html).not.toContain("<td>60.1%</td>"); // shares withheld
	expect(html).toContain("shares withheld until 100+ events");
});

test("rank table: no snapshot — dashes and no as-of line", () => {
	const html = renderTransparencyHtml({ snapshot: SNAPSHOT });
	expect(html).toContain("Client choices");
	expect(html).toContain("<td>firefly</td>");
	expect(html).not.toContain("rank stats as of");
});

test("JSON twin: clientRank live with zero-filled roster and published weights", () => {
	const json = transparencyJson(SNAPSHOT, RANK) as {
		clientRank: {
			status: string;
			total: number;
			warmingUp: boolean;
			weights: { first: number; auto: number };
			clients: Array<{
				id: string;
				first: number | null;
				score: number | null;
				share: number | null;
			}>;
		};
	};
	expect(json.clientRank.status).toBe("live");
	expect(json.clientRank.total).toBe(250);
	expect(json.clientRank.weights.auto).toBe(0.1);
	const firefly = json.clientRank.clients.find((c) => c.id === "firefly");
	expect(firefly?.score).toBe(21.4);
	expect(firefly?.share).toBe(60.1);
	// Zero-filled, not missing: quorum was observed zero times.
	const quorum = json.clientRank.clients.find((c) => c.id === "quorum");
	expect(quorum?.first).toBe(0);
	expect(quorum?.score).toBe(0);
	expect(quorum?.share).toBeNull();
});

test("JSON twin: clientRank coming-soon with nulls", () => {
	const json = transparencyJson(SNAPSHOT) as {
		clientRank: {
			status: string;
			window: null;
			clients: Array<{ id: string; score: number | null }>;
		};
	};
	expect(json.clientRank.status).toBe("coming-soon");
	expect(json.clientRank.window).toBeNull();
	expect(json.clientRank.clients.find((c) => c.id === "firefly")?.score).toBeNull();
});

test("JSON twin: the tracking counters shape declares both datapoints", () => {
	const json = transparencyJson(SNAPSHOT, RANK) as {
		tracking: {
			counters: { pageLoad: string; clientChoice: string };
		};
	};
	expect(json.tracking.counters.pageLoad).toContain("per page load");
	expect(json.tracking.counters.clientChoice).toContain("per client selection");
	expect(json.tracking.counters.clientChoice).toContain("No cast IDs");
});

// --- client coverage + phase-2 tracking copy (PLAN7 phase 3) ---

test("capability matrix: registry-driven clients x kinds on HTML", () => {
	const html = renderTransparencyHtml({ snapshot: SNAPSHOT, rank: RANK });
	expect(html).toContain("Client coverage");
	// farcaster: every kind seeded.
	expect(html).toContain(
		"<td>farcaster</td><td>✓</td><td>✓</td><td>✓</td><td>✓</td>",
	);
	// quorum: every kind — the feed target verified Oct 2026 (the profile
	// deep link IS the cast-list surface, PLAN7 §2 merged surface).
	expect(html).toContain(
		"<td>quorum</td><td>✓</td><td>✓</td><td>✓</td><td>✓</td>",
	);
	// quilcast: cast + profile.
	expect(html).toContain(
		"<td>quilcast</td><td>✓</td><td>✓</td><td>—</td><td>—</td>",
	);
	// linkcast: cast only.
	expect(html).toContain(
		"<td>linkcast</td><td>✓</td><td>—</td><td>—</td><td>—</td>",
	);
	// Registry-driven: every ACTIVE client renders a row, whatever the roster.
	for (const client of CLIENTS.filter(
		(c) => c.status === undefined || c.status === "active",
	)) {
		expect(html).toContain(`<td>${client.id}</td>`);
	}
});

test("JSON twin: the clients block lists per-kind coverage", () => {
	const json = transparencyJson(SNAPSHOT, RANK) as {
		clients: Array<{ id: string; kinds: string[] }>;
	};
	expect(json.clients.find((c) => c.id === "farcaster")?.kinds).toEqual([
		"cast",
		"profile",
		"feed",
		"channel",
	]);
	expect(json.clients.find((c) => c.id === "linkcast")?.kinds).toEqual([
		"cast",
	]);
	expect(json.clients.find((c) => c.id === "quorum")?.kinds).toEqual([
		"cast",
		"profile",
		"feed",
		"channel",
	]);
});

test("tracking copy declares the route kind and the per-kind cookie memory", () => {
	const json = transparencyJson(SNAPSHOT, RANK) as {
		tracking: { counters: { clientChoice: string }; cookies: string };
	};
	expect(json.tracking.counters.clientChoice).toContain("which surface");
	expect(json.tracking.cookies).toContain("profiles");
	const html = renderTransparencyHtml({ snapshot: SNAPSHOT, rank: RANK });
	expect(html).toContain("which surface");
	expect(html).toContain("for casts, profiles, and feeds separately");
	// The What line covers the whole waypoint family now.
	expect(html).toContain("profiles, feeds, and channels");
});
