// /transparency — terse, agent-friendly facts about how forkcaster works:
// what it is, where data comes from, what is and isn't tracked, plus the
// provider roster and live race telemetry (offline-generated snapshot,
// read from lmdis through the per-isolate TTL cache; absent → dashes).
// HTML for humans, JSON for agents (same negotiation as cast pages).
import type { Snapshot } from "../scripts/race-stats-lib.ts";
import type { ProviderId } from "./cast-source.ts";
import { escapeHtml, shell } from "./cast-page.tsx";

// Public provider roster — names included on purpose (transparency over
// infra obscurity). Keyed by ProviderId so a roster change in
// cast-source.ts fails the typecheck here instead of drifting silently.
const PROVIDER_HOSTS: Record<ProviderId, string> = {
	shim: "shim.artlu.xyz",
	"farcaster-tv": "farcaster.tv (partial)",
	haatz: "haatz.quilibrium.com",
	snap: "snap.farcaster.xyz:3381",
};
const PROVIDERS = Object.entries(PROVIDER_HOSTS).map(([id, host]) => ({
	id: id as ProviderId,
	host,
}));

const REPO = "https://github.com/artlu99/forkcaster_xyz";

// Domain registration facts, hand-verified against the registries' RDAP.
// Static on purpose: the RDAP links are the live source of truth — a renewal
// moves the real dates even while these lag until re-checked.
const DOMAINS = {
	checked: "2026-10-22",
	registrations: [
		{
			name: "forkcaster.xyz",
			role: "canonical",
			registrar: "Cloudflare, Inc.",
			registered: "2026-10-20",
			expires: "2027-10-20",
			rdap: "https://rdap.centralnic.com/xyz/domain/forkcaster.xyz",
		},
		{
			name: "warpcats.com",
			role: "alias",
			registrar: "Cloudflare, Inc.",
			registered: "2026-10-21",
			expires: "2027-10-21",
			rdap: "https://rdap.verisign.com/com/v1/domain/warpcats.com",
		},
	],
};

function statsTable(snapshot: Snapshot | null | undefined): string {
	const head = ["id", "wins", "p50", "p95", "err%", "host"]
		.map((h) => `<th>${h}</th>`)
		.join("");
	const byId = new Map((snapshot?.providers ?? []).map((p) => [p.id, p]));
	const body = PROVIDERS.map((p) => {
		const s = byId.get(p.id);
		const cells = [
			p.id,
			s ? String(s.wins) : "—",
			s?.p50Ms != null ? `${s.p50Ms}ms` : "—",
			s?.p95Ms != null ? `${s.p95Ms}ms` : "—",
			s ? `${Math.round(s.errorRate * 100)}%` : "—",
			p.host,
		];
		return `<tr>${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`;
	}).join("");
	const asOf =
		snapshot == null
			? ""
			: `<li>stats as of <code>${escapeHtml(snapshot.generatedAt)}</code> · window ${snapshot.window.hours}h${snapshot.sampled ? " · sampled" : ""} · completes that miss the 700ms box are cut by design</li>`;
	const asOfHtml = asOf === "" ? "" : `<ul>${asOf}</ul>`;
	return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${asOfHtml}`;
}

export function transparencyJson(
	snapshot?: Snapshot | null,
): Record<string, unknown> {
	const nullStats = () => ({
		wins: null,
		requests: null,
		p50Ms: null,
		p95Ms: null,
		errorRate: null,
	});
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
				"fc_client only — remembers your last-used app, whether auto-open is on, and the delay (0–5s). Host-only, 1 year.",
		},
		domains: {
			canonical: "https://forkcaster.xyz",
			also: ["https://warpcats.com"],
			checked: DOMAINS.checked,
			registrations: DOMAINS.registrations,
		},
		racingStats: snapshot
			? {
					status: "live",
					generatedAt: snapshot.generatedAt,
					window: snapshot.window,
					sampled: snapshot.sampled,
					outcomes: snapshot.outcomes,
					providers: PROVIDERS.map((p) => {
						const s = snapshot.providers.find((x) => x.id === p.id);
						return {
							id: p.id,
							...(s ?? nullStats()),
							host: p.host,
						};
					}),
				}
			: {
					status: "coming-soon",
					window: null,
					providers: PROVIDERS.map((p) => ({
						id: p.id,
						...nullStats(),
						host: p.host,
					})),
				},
	};
}

export function renderTransparencyHtml(
	options: { canonicalUrl?: string; snapshot?: Snapshot | null } = {},
): string {
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
${statsTable(options.snapshot)}
<ul>
<li>Ban check (has the author signed Farcaster's contract?): shim <code>/signed/{fid}</code>. Unknown → fail open, everything shown.</li>
</ul>

<h2>Tracking</h2>
<ul>
<li>One anonymous counter per page load: winning provider, latencies, host. No cast IDs, no IPs, no accounts, no ads.</li>
<li>One cookie: <code>fc_client</code> — remembers your last-used app, whether auto-open is on, and the delay (0–5s). Host-only, 1 year, never sent cross-site.</li>
<li>JSON version of this page: add <code>?format=json</code>.</li>
</ul>

<h2>Domains</h2>
<ul>
${DOMAINS.registrations
	.map(
		(d) =>
			`<li><code>${escapeHtml(d.name)}</code> — ${d.role === "canonical" ? "canonical" : "same pages"} · expires ${d.expires} · <a href="${d.rdap}">RDAP</a></li>`,
	)
	.join("\n")}
<li>Checked ${DOMAINS.checked} · RDAP links are live registry data.</li>
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
