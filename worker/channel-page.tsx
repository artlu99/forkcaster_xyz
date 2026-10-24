// Channel landing pages — resolve once, render twice.
//
// Waypoint law: identity is the page, lists are skeletons (never feeds —
// here: no list at all until shim grows a cheap one — shim's channel
// feed measured 8–15s+ cold), interaction
// lives in the clients. The identity card surfaces exactly the entity
// api.farcaster.xyz /v1/channel returns, parsed by worker/warpcast.ts —
// empty-prone fields render nothing, never faked, and nothing beyond it is
// fetched. Engagement counts (follower/member) are withheld from HTML and
// carried in the JSON twin. The way out is a hand-verified pill
// trio: no auto-open, no last-used memory, no telemetry — the
// only script is the cast row's DEEPLINK_SCRIPT, reused for click-time
// native attempts precisely because it carries no state.
//
// Identity verdict: the API's HTTP 400 errors-envelope is the authoritative
// miss; every other failure (other non-2xx, throw, timeout, malformed 200)
// is unreachable ⇒ 503 + Retry-After in BOTH variants — a channel landing
// has no fail-open content source, same as profiles.

import { DEEPLINK_SCRIPT } from "./cast-scripts.ts";
import { UPSTREAM_TIMEOUT_MS } from "./cast-source.ts";
import {
	clientsForRoute,
	pointerClass,
	resolveTemplate,
	targetDeeplinkTargets,
	targetFor,
	type ClientTarget,
	type TemplateVars,
} from "./client-registry.ts";
import { getChannelById, type WarpcastChannel } from "./warpcast.ts";
import { collapseText, escapeHtml, formatDate, shell } from "./shell.tsx";

export type ResolvedChannel =
	| { kind: "found"; channel: WarpcastChannel }
	| { kind: "not-found" }
	| { kind: "unreachable" };

/** Resolve once: one ~150ms API call, 5s cap, no caching (repo stance). */
export async function resolveChannel(id: string): Promise<ResolvedChannel> {
	const lookup = await getChannelById(
		id,
		AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
	);
	if (lookup.status === "miss") return { kind: "not-found" };
	if (lookup.status === "error") return { kind: "unreachable" };
	return { kind: "found", channel: lookup.channel };
}

// --- HTML renderer -----------------------------------------------------------

const CHANNEL_STYLE = `<style>
.channel-banner { width: 100%; max-height: 150px; object-fit: cover; border-radius: 12px; border: 1px solid var(--line); margin: 8px 0 0; display: block; }
.channel-card { display: flex; gap: 16px; align-items: flex-start; margin: 14px 0 0; }
.channel-avatar { width: 72px; height: 72px; border-radius: 16px; flex: none; }
.channel-avatar-fallback { display: flex; align-items: center; justify-content: center; background: var(--accent-soft); color: var(--accent); font-weight: 700; font-size: 30px; }
.channel-head { min-width: 0; }
.channel-title { font-size: 22px; font-weight: 700; margin: 0; line-height: 1.3; overflow-wrap: anywhere; }
.channel-handle { color: var(--muted); margin: 2px 0 0; }
.channel-description { margin: 10px 0 0; font-size: 15px; overflow-wrap: anywhere; }
.channel-facts { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; color: var(--muted); font-size: 13px; }
/* Pointer-class pill picker (same pattern as the profile unsigned way
   out): the full trio ships in the SSR HTML — byte-identical for every
   device, no UA sniffing — and CSS hides the coarse-only pill on
   desktop, where Quorum's web build has no channel page. */
@media (pointer: coarse) { .fine-only { display: none; } }
@media (pointer: fine) { .coarse-only { display: none; } }
</style>`;

// The way out (owner call: desktop = Farcaster + Firefly; phones add
// Quorum). The trio renders from the REGISTRY: each
// client's channel target carries its verified URL/scheme/package facts
// (per-target provenance in client-registry.ts — the full verification
// record lives there). Statelessness is the law here: the row
// is logo-less markup with no data-client, no badge, no beacon — the href
// is the only thing that ever leaves the page.
function channelActionsHtml(id: string, external: string | null): string {
	const vars: TemplateVars = { channelId: id };
	const pills = clientsForRoute("channel", vars).map((client) => {
		const target = targetFor(client, "channel") as ClientTarget;
		const targets = targetDeeplinkTargets(target, vars);
		// This renderer's established attribute order: href, scheme, intent.
		return `<a class="pill${pointerClass(target)}" href="${escapeHtml(resolveTemplate(target.web, vars))}"` +
			(targets.scheme ? ` data-scheme="${escapeHtml(targets.scheme)}"` : "") +
			(targets.intent ? ` data-intent="${escapeHtml(targets.intent)}"` : "") +
			`>${escapeHtml(client.title)}</a>`;
	});
	if (external) pills.push(external);
	return `<p class="actions">${pills.join("")}</p>${DEEPLINK_SCRIPT}`;
}

/**
 * The channel's own way out: a second pill next to "Open on Farcaster".
 * The URL is untrusted upstream data — only http(s) ships (javascript: and
 * friends are dropped at render), the label is the API's title else the
 * hostname, and everything rides escapeHtml into the attribute.
 */
function externalLinkPill(
	link: { title?: string; url?: string } | null | undefined,
): string | null {
	const url = (link?.url ?? "").trim();
	if (!/^https?:\/\//i.test(url)) return null;
	let host = "";
	try {
		host = new URL(url).hostname;
	} catch {
		return null;
	}
	const label = (link?.title ?? "").trim() || host;
	return `<a class="pill" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

function notFoundPage(id: string): string {
	return shell(
		`${id} · forkcaster`,
		`<p class="notice">Channel not found: /${escapeHtml(id)}. The channel id may be wrong or the channel retired.</p>`,
	);
}

function unavailablePage(id: string): string {
	return shell(
		`${id} · forkcaster`,
		`<p class="notice">Channel data is temporarily unavailable. <a href="/~/channel/${escapeHtml(id)}">Retry</a>.</p>`,
	);
}

/**
 * HTML: identity card — the whole parsed entity, nothing more. One
 * stateless script (the pill row's native attempts); zero cookies, zero
 * telemetry; strict statuses (404 for the API's authoritative miss,
 * 503 + Retry-After when it's unreachable — no fail-open source for
 * identity, unlike casts).
 */
export function renderChannelHtml(
	channel: ResolvedChannel,
	id: string,
	primaryOrigin?: string,
): { status: 200 | 404 | 503; html: string } {
	if (channel.kind === "not-found") {
		return { status: 404, html: notFoundPage(id) };
	}
	if (channel.kind === "unreachable") {
		return { status: 503, html: unavailablePage(id) };
	}
	const ch = channel.channel;
	const name = ch.name?.trim() ? ch.name : id;
	const description = collapseText(ch.description);

	const icon = ch.imageUrl
		? `<img class="channel-avatar" src="${escapeHtml(ch.imageUrl)}" alt="" />`
		: `<div class="channel-avatar channel-avatar-fallback" aria-hidden="true">${escapeHtml(id.charAt(0).toUpperCase())}</div>`;
	const banner = ch.headerImageUrl
		? `<img class="channel-banner" src="${escapeHtml(ch.headerImageUrl)}" alt="" />`
		: "";

	const facts: string[] = [];
	const created =
		typeof ch.createdAt === "number" ? formatDate(ch.createdAt) : "";
	if (created) facts.push(`<li>Created ${escapeHtml(created)}</li>`);
	if (typeof ch.leadFid === "number") facts.push(`<li>lead fid ${ch.leadFid}</li>`);

	const external = externalLinkPill(ch.externalLink);

	const body = `
${CHANNEL_STYLE}
${banner}
<div class="channel-card">
${icon}
<div class="channel-head">
<h1 class="channel-title">${escapeHtml(name)}</h1>
<p class="channel-handle">/${escapeHtml(id)}</p>
${description ? `<p class="channel-description">${escapeHtml(description)}</p>` : ""}
${facts.length > 0 ? `<ul class="channel-facts">${facts.join("")}</ul>` : ""}
</div>
</div>
${channelActionsHtml(id, external)}`;

	const og = {
		ogTitle: `${name} (/${id})`,
		description:
			description.slice(0, 280) || `The /${id} channel on Farcaster`,
		...(ch.imageUrl ? { image: ch.imageUrl } : {}),
	};
	// Canonical + og:url carry the /~/channel/{id} shape — the form
	// farcaster.xyz itself canonicalizes to (warpcast.com 301s there), so
	// forkcaster serves only that shape (owner call: the bare /channel/{id}
	// alias was removed).
	const canonicalUrl = primaryOrigin
		? `${primaryOrigin}/~/channel/${encodeURIComponent(id)}`
		: undefined;
	return {
		status: 200,
		html: shell(`${id} · forkcaster`, body, og, undefined, canonicalUrl, "website"),
	};
}

// --- JSON renderer -----------------------------------------------------------

/**
 * Agent JSON twin (?format=json) — strict statuses like the cast/profile
 * JSON: 404 on the API's authoritative miss, 503 + Retry-After when
 * unreachable. Availability-gated fields appear only when their data
 * exists; this is where the engagement counts live (HTML withholds them),
 * alongside the routing data HTML doesn't carry (parentUrl,
 * pinnedCastHash, moderatorFids).
 */
export function renderChannelJson(
	channel: ResolvedChannel,
	id: string,
): {
	status: 200 | 404 | 503;
	body: Record<string, unknown>;
	retryAfter?: "60";
} {
	if (channel.kind === "not-found") {
		return { status: 404, body: { error: "channel not found" } };
	}
	if (channel.kind === "unreachable") {
		return {
			status: 503,
			body: { error: "channel data temporarily unavailable" },
			retryAfter: "60",
		};
	}
	const ch = channel.channel;
	const body: Record<string, unknown> = { id };
	if (ch.name) body.name = ch.name;
	if (ch.description) body.description = ch.description;
	if (ch.imageUrl) body.image = ch.imageUrl;
	if (ch.headerImageUrl) body.headerImage = ch.headerImageUrl;
	if (typeof ch.createdAt === "number") {
		// unix-SECOND API timestamps → ISO, same convention as the profile
		// twin. An out-of-range number would make toISOString throw — a
		// misbehaving answer is treated as absent, never a 500 (the HTML
		// path's formatDate NaN guard does the same job).
		const date = new Date(ch.createdAt * 1000);
		if (Number.isFinite(date.getTime())) body.createdAt = date.toISOString();
	}
	if (ch.url) body.parentUrl = ch.url;
	if (typeof ch.leadFid === "number") body.leadFid = ch.leadFid;
	if (ch.moderatorFids && ch.moderatorFids.length > 0) {
		body.moderatorFids = ch.moderatorFids;
	}
	if (typeof ch.followerCount === "number") {
		body.followerCount = ch.followerCount;
	}
	if (typeof ch.memberCount === "number") body.memberCount = ch.memberCount;
	if (typeof ch.publicCasting === "boolean") {
		body.publicCasting = ch.publicCasting;
	}
	if (ch.pinnedCastHash) body.pinnedCastHash = ch.pinnedCastHash;
	if (ch.externalLink?.url) body.externalLink = ch.externalLink;
	body.farcaster = `https://farcaster.xyz/~/channel/${id}`;
	return { status: 200, body };
}
