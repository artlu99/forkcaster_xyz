/**
 * Transparency page tests: the racing-stats table fills from the snapshot
 * and degrades to "coming soon" dashes when it's absent — on both the
 * HTML page and the JSON twin. The Domains section carries static
 * registration facts (expiry + RDAP confirm links) on both variants.
 */
import { expect, mock, test } from "bun:test";

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
