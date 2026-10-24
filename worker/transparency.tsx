// /transparency — terse, agent-friendly facts about how forkcaster works:
// what it is, where data comes from, what is and isn't tracked, plus the
// provider roster, live race telemetry and the client-rank table (both
// offline-generated snapshots, read from lmdis through the per-isolate
// TTL cache; absent → dashes). HTML for humans, JSON for agents (same
// negotiation as cast pages).
import type { RankSnapshot, RankRow } from "../scripts/client-rank-lib.ts";
import { RANK_IDS, RANK_WEIGHTS, WARMING_UP_MIN } from "../scripts/client-rank-lib.ts";
import type { Snapshot } from "../scripts/race-stats-lib.ts";
import type { ProviderId } from "./cast-source.ts";
import { CLIENTS, ROUTE_KINDS, targetFor } from "./client-registry.ts";
import { escapeHtml, shell } from "./shell.tsx";

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

const WEIGHTS_NOTE = `first picks ×${RANK_WEIGHTS.first} · go-now ×${RANK_WEIGHTS.goNow} · repeats ×${RANK_WEIGHTS.repeat} · auto-opens ×${RANK_WEIGHTS.auto}`;

// Client coverage (PLAN7 phase 3): the capability matrix, straight from
// the registry — clients × route kinds. A — means "not verified yet",
// never "never"; the table cannot drift from client-registry.ts because
// it IS the registry.
const ACTIVE_CLIENTS = CLIENTS.filter(
	(client) => client.status === undefined || client.status === "active",
);

function coverageTable(): string {
	const head = ["client", ...ROUTE_KINDS]
		.map((h) => `<th>${escapeHtml(h)}</th>`)
		.join("");
	const body = ACTIVE_CLIENTS.map((client) => {
		const cells = [
			client.id,
			...ROUTE_KINDS.map((kind) =>
				targetFor(client, kind) !== undefined ? "✓" : "—",
			),
		];
		return `<tr>${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`;
	}).join("");
	return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table><ul><li>Straight from the registry. A — means not verified yet, not never; cast targets open the individual cast, the other kinds are that route's way out.</li></ul>`;
}

/** The JSON half of the coverage matrix (same source, same moment). */
const CLIENT_COVERAGE = ACTIVE_CLIENTS.map((client) => ({
	id: client.id,
	kinds: ROUTE_KINDS.filter((kind) => targetFor(client, kind) !== undefined),
}));

function rankTable(rank: RankSnapshot | null | undefined): string {
	const rows = new Map((rank?.rows ?? []).map((r) => [r.id, r]));
	const body = RANK_IDS.map((id) => {
		const r: RankRow | undefined = rows.get(id);
		const share =
			r?.share != null ? `${r.share}%` : "—";
		const cells = [
			id,
			r ? String(r.first) : "—",
			r ? String(r.pill) : "—",
			r ? String(r.goNow) : "—",
			r ? String(r.auto) : "—",
			r ? String(r.score) : "—",
			share,
		];
		return `<tr>${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`;
	}).join("");
	const asOf =
		rank == null
			? ""
			: `<li>rank stats as of <code>${escapeHtml(rank.generatedAt)}</code> · window ${rank.window.hours}h · ${rank.total} events${rank.sampled ? " · sampled" : ""}${rank.warmingUp ? ` · shares withheld until ${WARMING_UP_MIN}+ events (warming up)` : ""}</li>`;
	const weights = `<li>score weights: ${WEIGHTS_NOTE} — auto-opens echo an earlier choice and count ~10× less; pill order follows this table</li>`;
	const asOfHtml = asOf === "" ? `<ul>${weights}</ul>` : `<ul>${weights}${asOf}</ul>`;
	return `<table><thead><tr><th>client</th><th>first picks</th><th>explicit</th><th>go-now</th><th>auto</th><th>score</th><th>share</th></tr></thead><tbody>${body}</tbody></table>${asOfHtml}`;
}

export function transparencyJson(
	snapshot?: Snapshot | null,
	rank?: RankSnapshot | null,
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
			// Shape note (declared change, PLAN3 §6): counters was a single
			// string; it is now one entry per counter so the click-through
			// datapoint is declared with the same precision as the page-load one.
			counters: {
				pageLoad:
					"1 anonymous datapoint per page load: winning provider, latencies, host. No cast IDs, no IPs, no accounts, no ads.",
				clientChoice:
					"1 anonymous datapoint per client selection: client id, choice type (explicit pick vs auto-open), transport, coarse device class, which surface (cast, profile, or feed page), host. No cast IDs, no IPs, no identifiers. Raw rows expire in <=90 days.",
			},
			cookies:
				"fc_client only — remembers your last-used app for casts, profiles, and feeds separately, whether auto-open is on, and the delay (0–5s). Host-only, 1 year.",
		},
		// Capability matrix (PLAN7 phase 3): the registry's coverage, public.
		clients: CLIENT_COVERAGE,
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
		clientRank: rank
			? {
					status: "live",
					generatedAt: rank.generatedAt,
					window: rank.window,
					sampled: rank.sampled,
					total: rank.total,
					warmingUp: rank.warmingUp,
					// Published methodology (PLAN3 §9): the weighting is part of
					// the public contract, not an implementation detail.
					weights: {
						first: RANK_WEIGHTS.first,
						switched: RANK_WEIGHTS.switched,
						repeat: RANK_WEIGHTS.repeat,
						goNow: RANK_WEIGHTS.goNow,
						auto: RANK_WEIGHTS.auto,
					},
					clients: RANK_IDS.map((id) => {
						const r = rank.rows.find((row) => row.id === id);
						return {
							id,
							first: r?.first ?? 0,
							switched: r?.switched ?? 0,
							repeat: r?.repeat ?? 0,
							pill: r?.pill ?? 0,
							goNow: r?.goNow ?? 0,
							auto: r?.auto ?? 0,
							score: r?.score ?? 0,
							// Shares carry meaning only above the warming-up floor.
							share: rank.warmingUp ? null : (r?.share ?? null),
						};
					}),
				}
			: {
					status: "coming-soon",
					window: null,
					clients: RANK_IDS.map((id) => ({
						id,
						first: null,
						switched: null,
						repeat: null,
						pill: null,
						goNow: null,
						auto: null,
						score: null,
						share: null,
					})),
				},
	};
}

export function renderTransparencyHtml(
	options: {
		canonicalUrl?: string;
		snapshot?: Snapshot | null;
		rank?: RankSnapshot | null;
	} = {},
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
<li>Farcaster casts, profiles, feeds, and channels → clean waypoints that route out to your client. No app, no login.</li>
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

<h2>Client choices</h2>
<p>Which client people open things with — casts, profiles, feeds. Pill order follows this table (a reordering — nothing is ever hidden on a surface it can serve, and the registry kill switch outranks popularity).</p>
${rankTable(options.rank)}

<h2>Client coverage</h2>
${coverageTable()}

<h2>Tracking</h2>
<ul>
<li>One anonymous counter per page load: winning provider, latencies, host. No cast IDs, no IPs, no accounts, no ads.</li>
<li>One anonymous counter per client selection: client id, choice type (explicit pick vs auto-open), transport, coarse device class, which surface (cast, profile, or feed page), host. No cast IDs, no IPs, no identifiers. Raw rows expire in ≤90 days; only aggregates persist.</li>
<li>One cookie: <code>fc_client</code> — remembers your last-used app for casts, profiles, and feeds separately, whether auto-open is on, and the delay (0–5s). Host-only, 1 year, never sent cross-site.</li>
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
