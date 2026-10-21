// /transparency — terse, agent-friendly facts about how forkcaster works:
// what it is, where data comes from, what is and isn't tracked, plus the
// provider roster and a placeholder for race telemetry. HTML for humans,
// JSON for agents (same negotiation as cast pages).
import { shell } from "./cast-page.tsx";

// Public provider roster — names included on purpose (transparency over
// infra obscurity). Mirrors worker/cast-source.ts; keep in sync.
const PROVIDERS = [
	{
		id: "shim",
		host: "shim.artlu.xyz",
	},
	{
		id: "farcaster-tv",
		host: "farcaster.tv (partial)",
	},
	{
		id: "haatz",
		host: "haatz.quilibrium.com",
	},
	{
		id: "snap",
		host: "snap.farcaster.xyz:3381",
	},
];

const REPO = "https://github.com/artlu99/forkcaster_xyz";

function statsTable(rows: Array<string[]>): string {
	const head = ["id", "wins", "p50", "p95", "errors", "host"]
		.map((h) => `<th>${h}</th>`)
		.join("");
	const body = rows
		.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
		.join("");
	return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function transparencyJson(): Record<string, unknown> {
	return {
		what: "Farcaster cast links -> clean redirects. No app, no login.",
		license: "MIT",
		code: REPO,
		data: {
			method: "race 4 providers in parallel; first validated answer wins",
			providers: PROVIDERS,
			banSignal:
				"author signed Farcaster's contract? shim /signed/{fid}; unknown -> fail open",
		},
		tracking: {
			counters:
				"1 anonymous datapoint per page load: winning provider, latencies, host. No cast IDs, no IPs, no accounts, no ads.",
			cookies:
				"fc_client only — remembers your last-used app button. Host-only, 1 year.",
		},
		domains: {
			canonical: "https://forkcaster.xyz",
			also: ["https://warpcats.com"],
		},
		racingStats: {
			status: "coming-soon",
			window: null,
			providers: PROVIDERS.map((p) => ({
				id: p.id,
				wins: null,
				requests: null,
				p50Ms: null,
				p95Ms: null,
				errorRate: null,
				host: p.host,
			})),
		},
	};
}

export function renderTransparencyHtml(
	options: { canonicalUrl?: string } = {},
): string {
	const placeholderRows = PROVIDERS.map((p) => [
		p.id,
		"—",
		"—",
		"—",
		"—",
		p.host,
	]);
	const body = `
<style>
.tr h2 { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin: 24px 0 6px; }
.tr p, .tr li { margin: 0 0 6px; font-size: 14px; }
.tr ul { margin: 0; padding-left: 18px; }
.tr table { border-collapse: collapse; font-size: 13px; margin: 6px 0; }
.tr th, .tr td { border: 1px solid var(--line); padding: 4px 10px; text-align: left; }
.tr th { color: var(--muted); font-weight: 500; }
.tr a { color: var(--ink); }
</style>
<div class="tr">
<p class="lede"><strong>transparency</strong></p>

<h2>What</h2>
<ul>
<li>Farcaster cast links → clean redirects. No app, no login.</li>
<li>MIT licensed open source: <a href="${REPO}">github.com/artlu99/forkcaster_xyz</a>.</li>
</ul>

<h2>Data</h2>
<ul>
<li>Cast data is raced across 4 providers in parallel; first validated answer wins.</li>
</ul>
${statsTable(placeholderRows)}
<ul>
<li>Ban check (has the author signed Farcaster's contract?): shim <code>/signed/{fid}</code>. Unknown → fail open, everything shown.</li>
</ul>

<h2>Tracking</h2>
<ul>
<li>One anonymous counter per page load: winning provider, latencies, host. No cast IDs, no IPs, no accounts, no ads.</li>
<li>One cookie: <code>fc_client</code> — remembers your last-used app button. Host-only, 1 year, never sent cross-site.</li>
<li>JSON version of this page: add <code>?format=json</code>.</li>
</ul>

<h2>Domains</h2>
<ul>
<li><code>forkcaster.xyz</code> — canonical domain</li>
<li><code>warpcats.com</code> — same pages</li>
</ul>

<p class="notice">Questions? <a href="${REPO}/issues">Open an issue</a>.</p>
</div>`;
	return shell(
		"transparency · forkcaster",
		body,
		{
			ogTitle: "forkcaster — transparency",
			description:
				"What forkcaster is, where cast data comes from, and what is (and isn't) tracked.",
		},
		undefined,
		options.canonicalUrl,
	);
}
