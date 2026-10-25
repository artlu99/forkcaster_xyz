// /transparency — terse, agent-friendly facts about how forkcaster works:
// what it is, where data comes from, what is and isn't tracked, plus the
// provider roster, live race telemetry and the client-rank table (both
// offline-generated snapshots, read from lmdis through the per-isolate
// TTL cache; absent → dashes). HTML for humans, JSON for agents (same
// negotiation as cast pages).
import type { RankSnapshot, RankRow } from "../scripts/client-rank-lib.ts";
import { RANK_IDS, RANK_WEIGHTS, WARMING_UP_MIN } from "../scripts/client-rank-lib.ts";
import { FID_SOURCES, type FidSnapshot } from "../scripts/fid-race-lib.ts";
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

/** The one table markup: headers verbatim (static vocabulary), cells escaped. */
function renderTable(headers: string[], rows: string[][]): string {
	const head = headers.map((h) => `<th>${h}</th>`).join("");
	const body = rows
		.map(
			(cells) =>
				`<tr>${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
		)
		.join("");
	return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function statsTable(snapshot: Snapshot | null | undefined): string {
	const byId = new Map((snapshot?.providers ?? []).map((p) => [p.id, p]));
	const rows = PROVIDERS.map((p) => {
		const s = byId.get(p.id);
		return [
			p.id,
			s ? String(s.wins) : "—",
			s?.p50Ms != null ? `${s.p50Ms}ms` : "—",
			s?.p95Ms != null ? `${s.p95Ms}ms` : "—",
			s ? `${Math.round(s.errorRate * 100)}%` : "—",
			p.host,
		];
	});
	const asOf =
		snapshot == null
			? ""
			: `<li>From <code>${escapeHtml(snapshot.generatedAt)}</code> · last ${snapshot.window.hours} hours${snapshot.sampled ? " · sampled" : ""} · answers later than 0.7 seconds are not counted</li>`;
	const asOfHtml = asOf === "" ? "" : `<ul>${asOf}</ul>`;
	return `${renderTable(["id", "wins", "p50", "p95", "err%", "host"], rows)}${asOfHtml}`;
}

const WEIGHTS_NOTE = `Score: first pick ×${RANK_WEIGHTS.first} · open now ×${RANK_WEIGHTS.goNow} · repeat ×${RANK_WEIGHTS.repeat} · automatic ×${RANK_WEIGHTS.auto}. An automatic open repeats an earlier choice, so it counts less.`;

// The fid-race rows in roster order — the row label IS the source id
// (shim = this site's reader; haatz/snap = the raw gateways, tracked
// independently). The vocabulary lives in the fid-race lib, typecheck-
// coupled to cast-source.ts's FidRace ids.

function fidTable(snapshot: FidSnapshot | null | undefined): string {
	const rows = FID_SOURCES.map((source) => {
		const stats = snapshot?.sources[source];
		return [
			source,
			stats ? String(stats.wins) : "—",
			stats?.p50Ms != null ? `${stats.p50Ms}ms` : "—",
			stats?.p95Ms != null ? `${stats.p95Ms}ms` : "—",
		];
	});
	const asOf =
		snapshot == null
			? ""
			: `<li>From <code>${escapeHtml(snapshot.generatedAt)}</code> · last ${snapshot.window.hours} hours${snapshot.sampled ? " · sampled" : ""} · ${snapshot.legs.haatz + snapshot.legs.snap} lookups raced</li>`;
	const asOfHtml = asOf === "" ? "" : `<ul>${asOf}</ul>`;
	return `${renderTable(["source", "wins", "p50", "p95"], rows)}${asOfHtml}`;
}

// Client coverage: the capability matrix, straight from the registry —
// clients × route kinds. A — means "not verified yet",
// never "never"; the table cannot drift from client-registry.ts because
// it IS the registry.
const ACTIVE_CLIENTS = CLIENTS.filter(
	(client) => client.status === undefined || client.status === "active",
);

function coverageTable(): string {
	const rows = ACTIVE_CLIENTS.map((client) => [
		client.id,
		...ROUTE_KINDS.map((kind) =>
			targetFor(client, kind) !== undefined ? "✓" : "—",
		),
	]);
	return `${renderTable(["app", ...ROUTE_KINDS], rows)}<ul><li>This table comes from the site's app list. A ✓ means that the link exists. A — means that we have not confirmed it yet.</li></ul>`;
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
		return [
			id,
			r ? String(r.first) : "—",
			r ? String(r.pill) : "—",
			r ? String(r.goNow) : "—",
			r ? String(r.auto) : "—",
			r ? String(r.score) : "—",
			share,
		];
	});
	const asOf =
		rank == null
			? ""
			: `<li>From <code>${escapeHtml(rank.generatedAt)}</code> · last ${rank.window.hours} hours · ${rank.total} selections${rank.sampled ? " · sampled" : ""}${rank.warmingUp ? ` · shares show at ${WARMING_UP_MIN}+ selections` : ""}</li>`;
	const weights = `<li>${WEIGHTS_NOTE}</li>`;
	const asOfHtml = asOf === "" ? `<ul>${weights}</ul>` : `<ul>${weights}${asOf}</ul>`;
	return `${renderTable(["app", "first picks", "selections", "open now", "automatic", "score", "share"], body)}${asOfHtml}`;
}

export function transparencyJson(
	snapshot?: Snapshot | null,
	rank?: RankSnapshot | null,
	fid?: FidSnapshot | null,
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
			// Shape note (declared change): counters was a single
			// string; it is now one entry per counter so the click-through
			// datapoint is declared with the same precision as the page-load one.
			counters: {
				pageLoad:
					"1 anonymous datapoint per page load: winning provider, latencies, host. No cast IDs, no IPs, no accounts, no ads.",
				clientChoice:
					"1 anonymous datapoint per client selection: client id, choice type (explicit pick vs auto-open), transport, coarse device class, which surface (cast, profile, or feed page), host. No cast IDs, no IPs, no identifiers. Raw rows expire in <=90 days.",
				fidRace:
					"1 anonymous datapoint per author-id lookup that settles: which source won (the site's own reader vs the public node), how fast, which node, host. No cast IDs, no IPs, no identifiers.",
			},
			cookies:
				"fc_client only — remembers your last-used app for casts, profiles, and feeds separately, whether auto-open is on, and the delay (0–5s). Host-only, 1 year.",
		},
		// Capability matrix: the registry's coverage, public.
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
		fidRace: fid
			? {
					status: "live",
					generatedAt: fid.generatedAt,
					window: fid.window,
					sampled: fid.sampled,
					legs: fid.legs,
					total:
						fid.sources.shim.wins +
						fid.sources.haatz.wins +
						fid.sources.snap.wins,
					sources: {
						shim: fid.sources.shim,
						haatz: fid.sources.haatz,
						snap: fid.sources.snap,
					},
				}
			: {
					status: "coming-soon",
					window: null,
					legs: { haatz: null, snap: null },
					total: null,
					sources: {
						shim: { wins: null, p50Ms: null, p95Ms: null },
						haatz: { wins: null, p50Ms: null, p95Ms: null },
						snap: { wins: null, p50Ms: null, p95Ms: null },
					},
				},
		clientRank: rank
			? {
					status: "live",
					generatedAt: rank.generatedAt,
					window: rank.window,
					sampled: rank.sampled,
					total: rank.total,
					warmingUp: rank.warmingUp,
					// Published methodology (the standing rules: pills are reordered, never
					// hidden — the kill switch outranks rank; rank is never a placement
					// product): the weighting is part of the public contract, not an
					// implementation detail.
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
		fid?: FidSnapshot | null;
	} = {},
): string {
	// Section order serves the common visitor: what it is → what's tracked
	// (the question they came with) → which clients work → which clients
	// people use → how the data plumbing works → domain facts. Pure block
	// moves — tables and copy unchanged; the JSON twin keeps its own key
	// order.
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
<li>Forkcaster shows Farcaster casts, profiles, feeds, and channels on simple pages. Open the links in the app that you choose. You do not need an app or an account to read.</li>
<li>Open source, MIT license: <a href="${REPO}">github.com/artlu99/forkcaster_xyz</a>.</li>
</ul>

<h2>Tracking</h2>
<ul>
<li>Each page view sends one anonymous count: the data source that answered first, the response time, and the site name. No cast IDs. No IP addresses. No accounts. No ads.</li>
<li>Each click on an app link sends one anonymous count: the app name, click or automatic open, website or app, phone or computer, the page type, and the site name. No cast IDs. No IP addresses. No other identifiers.</li>
<li>We delete the raw counts after 90 days. Only the totals stay.</li>
<li>One cookie, <code>fc_client</code>: the apps that you used last (casts, profiles, and feeds separately), your auto-open setting, and the wait time (0 to 5 seconds). It stays on this site and never goes to other sites. It expires after one year.</li>
<li>For a JSON version of this page, add <code>?format=json</code>.</li>
</ul>

<h2>App links</h2>
${coverageTable()}

<h2>App use</h2>
<p>This table shows the apps that people use. The app links on each page follow this order. No app is removed from a page that it can open.</p>
${rankTable(options.rank)}

<h2>Data</h2>
<ul>
<li>Forkcaster asks 4 data sources at the same time and uses the first good answer.</li>
</ul>
${statsTable(options.snapshot)}
<ul>
<li>Some apps show only authors who signed the Farcaster agreement. We check this. If the check does not answer, we show every app.</li>
</ul>

<h2>Author id races</h2>
<p>Some apps need the author's numeric id. On each raw-node fetch, shim (this site's reader) races the node's own proof route — the fastest answer wins, and each node is tracked separately.</p>
${fidTable(options.fid)}

<h2>Domains</h2>
<ul>
${DOMAINS.registrations
	.map(
		(d) =>
			`<li><code>${escapeHtml(d.name)}</code> — ${d.role === "canonical" ? "main" : "same pages"} · expires ${d.expires} · <a href="${d.rdap}">RDAP</a></li>`,
	)
	.join("\n")}
<li>Checked ${DOMAINS.checked}. The RDAP links show the current registry data.</li>
</ul>

<p class="notice">Questions? <a href="${REPO}/issues">Open an issue</a>.</p>
</div>`;
	return shell(
		"transparency · forkcaster",
		body,
		{
			ogTitle: "forkcaster — transparency",
			description:
				"What forkcaster shows, what it collects, and where the data comes from.",
		},
		undefined,
		options.canonicalUrl,
	);
}
