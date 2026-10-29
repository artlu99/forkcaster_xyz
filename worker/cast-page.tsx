// The cast page orchestrator: resolve once, render twice.
//
// resolveCast() races providers (cast-source.ts), unfurls URL embeds,
// hydrates quote embeds, and checks the author signed-state — then
// renderCastHtml() / renderCastJson() / renderQuotesFragment() render the
// one result. Supporting modules:
//   cast-data.ts    — Shim → embed-data mapping (pure)
//   cast-actions.tsx — action row + auto-open banner (server halves)
//   cast-scripts.ts — the inline client scripts those halves pair with
//   shell.tsx       — the page frame (shared with /transparency)
import { renderToString } from "preact-render-to-string";
import { FarcasterEmbed } from "react-farcaster-embed";
import type { RankSnapshot } from "../scripts/client-rank-lib.ts";
import {
	type ProviderId,
	type ProviderTiming,
	raceCast,
	shimProvider,
	UPSTREAM_TIMEOUT_MS,
} from "./cast-source.ts";
import {
	type CastData,
	hasExternalLinks,
	imageUrlsOf,
	primaryHandle,
	type QuoteTarget,
	type UnfurlResult,
	quoteTargetsOf,
	STATS_ROW,
	toCastData,
	toOgDescription,
	urlEmbedsOf,
} from "./cast-data.ts";
import { autoOpenUi, clientActionsHtml } from "./cast-actions.tsx";
import {
	CLIENT_SCRIPT,
	LIVE_STATS_SCRIPT,
	QUOTE_FILL_SCRIPT,
	TRACK_SCRIPT,
} from "./cast-scripts.ts";
import type { ClientPrefs } from "./clients.ts";
import type { TemplateVars } from "./client-registry.ts";
import {
	getCastByHash,
	getCastByUsernameHash,
	getSignedStatus,
	getUsernameByFid,
	type ShimCast,
} from "./shim.ts";
import { escapeHtml, shell } from "./shell.tsx";

// react-farcaster-embed emits every card anchor as a bare target="_blank"
// (url cards, images, body links, the Show-on-Farcaster icon) with no rel.
// Browsers imply noopener there today, but spell it out server-side for
// parity with the stats links the live-stats script builds (cast-scripts.ts).
// Shared with the casts skeleton page, which renders the same cards.
export function hardenBlankTargets(html: string): string {
	return html.replaceAll('target="_blank"', 'target="_blank" rel="noopener"');
}

// For a signed:false author the cast URL the embed stamps on every card
// (the Show-on-Farcaster icon → farcaster.xyz/{username}/{hash}) is a dead
// link — farcaster.xyz is read-only for them — while the forkcaster waypoint
// always resolves. This retargets that one anchor to the local waypoint and
// relabels it. Class-scoped on purpose: the avatar/profile anchor stays
// (farcaster.xyz/~/profiles/{fid} works for unsigned accounts), and
// author-typed farcaster.xyz links in cast text are content — they keep
// their farcaster-embed-body-link class and are never touched. Applied only
// when signedness PROVES the link dead (=== false); unknown fails open.
// Shared with the casts skeleton page, which renders the same cards.
export function relinkFarcasterAnchor(html: string, castPath: string): string {
	return html.replace(
		/<a\b[^>]*\bclass="farcaster-embed-farcaster-link"[^>]*>/g,
		(tag) =>
			tag
				.replace(/href="[^"]*"/, () => `href="${castPath}"`)
				.replace(
					/title="Show on Farcaster"/,
					() => 'title="Open on forkcaster"',
				),
	);
}

// Render one embed card — the pipeline every card surface shares:
// react-farcaster-embed SSR, hardened blank targets, and the library's
// zero-count stats stub swapped for the live-stats slot (the script fills
// every `.farcaster-embed-stats[data-username]` slot on the page; each
// degrades alone). Knobs, per surface:
//   local    — the farcaster.xyz cast URL is dead/unwanted on this
//              surface: the slot ships data-local="1" and LIVE_STATS_SCRIPT
//              writes local waypoint links instead of farcaster.xyz ones.
//   hideIcon — hide the Show-on-Farcaster icon outright (the library's own
//              option). The individual cast page uses it for proven-unsigned
//              authors: the icon's only honest local twin would self-link
//              this very waypoint.
//   castPath — retarget the icon to this local waypoint and relabel it
//              "Open on forkcaster". List pages use it: the waypoint is
//              another page — never a self-link — and it resolves for
//              every author, signed or not.
//   noStats  — drop the zero-stub stats row entirely (quote cards carry
//              no live-stats slot).
// The ONE card pipeline: the individual cast page (hideIcon+local for
// proven-unsigned authors), the quote fragment (noStats), and the casts
// list (local+castPath) all render through it.
export async function renderEmbedCard(opts: {
	username: string;
	hash: string;
	castData: CastData;
	local?: boolean;
	hideIcon?: boolean;
	castPath?: string;
	noStats?: boolean;
}): Promise<string> {
	let html = hardenBlankTargets(
		renderToString(
			(await FarcasterEmbed({
				username: opts.username,
				hash: opts.hash,
				castData: opts.castData,
				...(opts.hideIcon
					? { options: { hideFarcasterLogo: true } }
					: {}),
			})) as never,
		),
	);
	html = opts.noStats
		? // Quote cards carry no live-stats slot: keep the bare slot div,
			// drop the zero-count stub (the script never fills a slot without
			// data-username, so this row stays inert).
			html.replace(STATS_ROW, (_match, opening: string) => opening)
		: html.replace(
				STATS_ROW,
				() =>
					`<div class="farcaster-embed-stats"${opts.local ? ' data-local="1"' : ""} data-username="${escapeHtml(opts.username)}" data-hash="${escapeHtml(opts.hash)}">`,
			);
	return opts.castPath ? relinkFarcasterAnchor(html, opts.castPath) : html;
}

// Exported for the casts skeleton page (same enrichment pipeline, same
// binding + plain-fetch fallback semantics).
export async function unfurl(
	url: string,
	env?: { UNFURL?: Fetcher },
): Promise<UnfurlResult | undefined> {
	// In production, a Worker fetching another workers.dev Worker on the same
	// account is blocked (Cloudflare error 1042) — the UNFURL service binding
	// is the sanctioned path. The plain-fetch fallback exists for local
	// dev/tests (and dev with a configured-but-unresolvable binding); in
	// production a binding failure means the fallback is expected to hit
	// 1042 — ≤5s wasted on an already-degraded path, never a wrong answer.
	const target = `https://unfurl.artlu.workers.dev/?u=${encodeURIComponent(url)}`;
	if (env?.UNFURL) {
		try {
			const res = await env.UNFURL.fetch(target, {
				signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
			});
			if (res.ok) {
				return (await res.json().catch(() => undefined)) as
					| UnfurlResult
					| undefined;
			}
		} catch {
			// Binding unavailable (e.g. local dev) — fall through.
		}
	}
	try {
		const res = await fetch(target, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
		if (!res.ok) return undefined;
		return (await res.json().catch(() => undefined)) as
			| UnfurlResult
			| undefined;
	} catch {
		return undefined;
	}
}

// Quote embeds are hydrated through Shim /h/{fullHash} (message embeds carry
// the full hash), but /h is a hash-only index and misses live casts
// (measured Oct 2026: a trish quote answered "Cast not found" while
// /wc/{username}/{hash} returned the message), so a miss falls back to the
// fid+hash path the castId embed carries: /u/{fid} → username →
// /wc/{username}/{hash}. One shared 5s window caps the whole chain — a
// quote never costs more latency than a single /h call did. Hydrated quotes
// map through toCastData (which provides the author.pfp the bundle reads
// unguarded) at depth 1 — their own quotes are never hydrated. Hydration
// failure still drops the quote — old casts get pruned from Snapchain when
// storage lapses.
// Exported for the casts skeleton page (same enrichment pipeline).
export async function fetchQuote(
	target: QuoteTarget,
): Promise<ShimCast | undefined> {
	const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
	const direct = await getCastByHash(target.hash, signal);
	if (direct || target.fid === undefined) return direct;
	try {
		const username = await getUsernameByFid(target.fid, signal);
		if (!username) return undefined;
		const lookup = await getCastByUsernameHash(username, target.hash, signal);
		return lookup.status === "found" ? lookup.cast : undefined;
	} catch {
		// /u network failure (it propagates rejections) — drop the quote.
		return undefined;
	}
}

function castPage(
	vars: TemplateVars,
	cardHtml: string,
	signed: boolean,
	og: {
		ogTitle: string;
		description?: string;
		image?: string;
		largeImage?: boolean;
	},
	prefs: ClientPrefs = {},
	partial = false,
	primaryOrigin?: string,
	noredirect = false,
	rank?: RankSnapshot | null,
	externalLinks?: boolean,
): string {
	// signed === false means the author hasn't accepted Farcaster's social
	// smart contract (Network Code) — their profile is read-only/banned on
	// farcaster.xyz, so the registry's requiresSigned clients (farcaster)
	// are suppressed. The embed itself still renders for everyone.
	const notice =
		signed === false
			? `<p class="notice">The author hasn't signed the social smart contract — the cast may be restricted on farcaster.xyz.</p>`
			: "";
	const actions = clientActionsHtml(
		vars,
		signed,
		prefs.slug,
		rank,
		externalLinks,
	);
	// Dual-serve canonicalization: every host renders the same page, but
	// points at the primary origin so link equity and unfurlers agree.
	// The full hash additionally dedupes short/long variants of the same
	// cast — the form the JSON renderer and MCP tool already advertise.
	const canonicalUrl = primaryOrigin
		// Cast vars carry username by contract (a resolved cast always has
		// its author handle); the ?? only satisfies the now-partial
		// TemplateVars type.
		? `${primaryOrigin}/${encodeURIComponent(vars.username ?? "")}/${vars.fullHash}`
		: undefined;
	const auto = autoOpenUi(prefs, signed, vars, noredirect, externalLinks);
	return shell(
		`${vars.username}/${vars.hash} · forkcaster`,
		`${auto.html}${cardHtml}${notice}${actions}`,
		og,
		`${TRACK_SCRIPT}${CLIENT_SCRIPT}${LIVE_STATS_SCRIPT}${partial ? QUOTE_FILL_SCRIPT : ""}${auto.script ?? ""}`,
		canonicalUrl,
	);
}

function linkOnlyPage(
	username: string,
	hash: string,
	slug?: string,
	noredirect = false,
	rank?: RankSnapshot | null,
): string {
	// No provider resolved the cast: signed state is unknown, which fails
	// open — every registry client is offered. External-link state is
	// unknown too, and that gate is fail-closed: requiresExternalLinks
	// clients stay hidden here. The route hash is used as-is (it may be
	// short-form); the {fullHash} slot degrades to it, and no fid is known,
	// so any future fid-gated client would be skipped here. Auto-open
	// fires here too (the cast lives in the client).
	const prefs: ClientPrefs = { slug };
	const auto = autoOpenUi(
		prefs,
		true,
		{ username, hash, fullHash: hash },
		noredirect,
	);
	return shell(
		`${username}/${hash} · forkcaster`,
		`${auto.html}<p class="notice">Cast data is temporarily unavailable.</p>${clientActionsHtml(
			{ username, hash, fullHash: hash },
			true,
			slug,
			rank,
		)}`,
		undefined,
		`${TRACK_SCRIPT}${CLIENT_SCRIPT}${auto.script ?? ""}`,
	);
}

function notFoundPage(username: string, hash: string): string {
	// username is a percent-decoded route param — escape it before it
	// reaches the body (the title is escaped inside shell()).
	return shell(
		`${username}/${hash} · forkcaster`,
		`<p class="notice">Cast not found: ${escapeHtml(username)}/${escapeHtml(hash)}. The username or hash may be wrong, or the cast was deleted.</p>`,
	);
}

// Everything both renderers need, fetched once ("resolve once, render
// twice"). found = a provider resolved the cast; not-found = an
// authoritative miss from a complete provider; unreachable = everyone
// failed. opts.boxMs: HTML passes a box (a quote-blind farcaster.tv win
// is allowed once it expires — the page self-heals quote cards); JSON
// passes null (shim-only, always complete).
export type ResolvedCast =
	| {
			kind: "found";
			cast: ShimCast & { hash: string };
			unfurlMap: Map<string, UnfurlResult | undefined>;
			quotes: Array<ShimCast | undefined>;
			signed: boolean | null;
			provider: ProviderId;
			partial: boolean;
			timings: ProviderTiming[];
			elapsedMs: number;
	  }
	| {
			kind: "not-found";
			timings: ProviderTiming[];
			elapsedMs: number;
	  }
	| {
			kind: "unreachable";
			timings: ProviderTiming[];
			elapsedMs: number;
	  };

export async function resolveCast(
	username: string,
	hash: string,
	env?: { UNFURL?: Fetcher },
	opts: { boxMs?: number | null } = {},
): Promise<ResolvedCast> {
	// The race is capped at 5s per provider (cast-source.ts): a cold sharded
	// lookup can otherwise hang for 15s+ (measured on a missing cast).
	const race =
		opts.boxMs === null
			? await raceCast({ username, hash }, { providers: [shimProvider] })
			: await raceCast({ username, hash }, { boxMs: opts.boxMs });
	if (race.kind !== "found") return race;
	const foundCast: ShimCast & { hash: string } = race.cast;

	// Enrich up to 3 URL embeds with Open Graph data (fails open) and
	// hydrate up to 3 quote embeds through Shim /h/{fullHash}. Partial wins
	// carry no {castId} embeds, so quotes are naturally empty there — the
	// page fills them in client-side (QUOTE_FILL_SCRIPT).
	const urlEmbeds = urlEmbedsOf(foundCast);
	const quoteTargets = quoteTargetsOf(foundCast);
	const unfurls = Promise.allSettled(urlEmbeds.map((u) => unfurl(u, env)));
	const quoteFetches = Promise.allSettled(
		quoteTargets.map((t) => fetchQuote(t)),
	);

	// Has the author signed the social smart contract? Unknown (null)
	// fails open: the farcaster.xyz link is shown unless Shim says no.
	// The check is time-boxed to the HTML box so a slow shim can't stall a
	// fast partial win; JSON waits fully (strict path).
	let signed: boolean | null = null;
	const fid = foundCast.fid ?? foundCast.user?.fid;
	if (fid !== undefined) {
		const signedPromise = getSignedStatus(fid, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS));
		if (opts.boxMs === null) {
			signed = await signedPromise;
		} else {
			let timer: ReturnType<typeof setTimeout> | undefined;
			signed = await Promise.race([
				signedPromise,
				new Promise<null>((resolve) => {
					timer = setTimeout(() => resolve(null), opts.boxMs ?? 700);
				}),
			]);
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	const unfurlResults = await unfurls;
	const unfurlMap = new Map<string, UnfurlResult | undefined>();
	urlEmbeds.forEach((u, i) => {
		const r = unfurlResults[i];
		unfurlMap.set(u, r.status === "fulfilled" ? r.value : undefined);
	});
	const quoteResults = await quoteFetches;
	const quotes = quoteResults.map((r) =>
		r.status === "fulfilled" ? r.value : undefined,
	);
	return {
		kind: "found",
		cast: foundCast,
		unfurlMap,
		quotes,
		signed,
		provider: race.provider,
		partial: race.partial,
		timings: race.timings,
		elapsedMs: race.elapsedMs,
	};
}

// HTML renderer: full SSR card + OG meta when found. Lenient statuses —
// unreachable still 200s as a link-only page so unfurlers never error.
// lastClientId (from the fc_client cookie) badges the visitor's
// last-used client; unknown ids are ignored by the registry.
export async function renderCastHtml(
	resolved: ResolvedCast,
	username: string,
	hash: string,
	prefs: ClientPrefs = {},
	primaryOrigin?: string,
	noredirect = false,
	rank?: RankSnapshot | null,
): Promise<{ status: 200 | 404; html: string }> {
	if (resolved.kind === "not-found") {
		return { status: 404, html: notFoundPage(username, hash) };
	}
	if (resolved.kind === "unreachable") {
		return {
			status: 200,
			html: linkOnlyPage(username, hash, prefs.slug, noredirect, rank),
		};
	}
	const { cast, unfurlMap, quotes, signed, partial } = resolved;
	try {
		// signed === false ⇒ the farcaster.xyz cast page is dead for this
		// author, and the icon's only honest local twin would self-link this
		// very waypoint — so the Show-on-Farcaster icon is hidden outright
		// (the library's own option). Unknown signedness fails open: the
		// icon stays. The stats slot rides the same data-local flag the
		// casts skeleton page uses — client-built links become (no-op)
		// local waypoints instead of dead farcaster.xyz ones.
		const local = signed === false;
		// Identity law: the cast's author handle everywhere is the PRIMARY
		// (fname first) — the embed's own links, the stats slot, the OG
		// title, and the canonical/pill vars. Absent user degrades to the
		// route input (today's bytes).
		const primary = primaryHandle(cast.user, username);
		const cardHtml = await renderEmbedCard({
			username: primary,
			hash,
			castData: toCastData(
				cast.user ? { ...cast, user: { ...cast.user, username: primary } } : cast,
				unfurlMap,
				quotes,
			),
			local,
			hideIcon: local,
		});
		// OG/Twitter meta so Telegram, Discord, iMessage etc. unfurl the
		// cast: author handle as title, cast text as description, first
		// image embed (else the avatar) as image.
		const ogTitle = cast.user?.displayName
			? `${cast.user.displayName} (@${primary})`
			: `@${primary}`;
		const firstImage = imageUrlsOf(cast)[0];
		const og = {
			ogTitle,
			description: toOgDescription(cast.text, quotes),
			image: firstImage ?? cast.user?.pfpUrl,
			largeImage: firstImage !== undefined,
		};
		const vars: TemplateVars = {
			username: primary,
			hash,
			fullHash: cast.hash,
			// Same fallback the signed check uses; undefined on fid-less
			// casts, which gates any fid-requiring client template.
			fid: cast.fid ?? cast.user?.fid,
		};
		return {
			status: 200,
			// Signed unknown fails open; the link gate is fail-closed, but
			// the cast is in hand here, so its state is always known.
			html: castPage(
				vars,
				cardHtml,
				signed !== false,
				og,
				prefs,
				partial,
				primaryOrigin,
				noredirect,
				rank,
				hasExternalLinks(cast),
			),
		};
	} catch {
		// Embed rendering failed — degrade to links instead of erroring.
		return {
			status: 200,
			html: linkOnlyPage(username, hash, prefs.slug, noredirect, rank),
		};
	}
}

// SSR fragment for QUOTE_FILL_SCRIPT: shim-resolved quote cards for a cast
// that a quote-blind provider won. Served at ?embeds=quotes with
// no-store; the fetcher is our own script, so any failure just means the
// quote cards stay absent (same degradation as the live stats row).
export async function renderQuotesFragment(
	username: string,
	hash: string,
): Promise<{ status: 200 | 404 | 503; html: string }> {
	const outcome = await shimProvider.fetchCast(
		{ username, hash },
		AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
	);
	if (outcome.kind === "error") return { status: 503, html: "" };
	if (outcome.kind === "miss") return { status: 404, html: "" };
	const quoteTargets = quoteTargetsOf(outcome.cast);
	const quoteFetches = await Promise.allSettled(
		quoteTargets.map((t) => fetchQuote(t)),
	);
	const cards: string[] = [];
	for (const settled of quoteFetches) {
		const quote = settled.status === "fulfilled" ? settled.value : undefined;
		if (!quote?.hash) continue;
		try {
			// Identity law: quote cards carry the quoted author's primary.
			const quoteUsername = primaryHandle(quote.user, username);
			cards.push(
				await renderEmbedCard({
					username: quoteUsername,
					hash: quote.hash,
					castData: toCastData(quote),
					// Quote cards carry no live-stats slot: the zero-stub
					// row is dropped inside the helper.
					noStats: true,
				}),
			);
		} catch {
			// A broken quote card must never take the fragment down.
		}
	}
	if (cards.length === 0) return { status: 200, html: "" };
	return {
		status: 200,
		html: `<div class="quote-embeds">\n${cards.join("\n")}\n</div>`,
	};
}

// JSON renderer for AI agents. Deliberately strict where HTML is lenient:
// not-found is a real 404 and unreachable is 503 + Retry-After, so agents
// can distinguish "wrong id" from "try again". Found bodies are
// availability-gated: a key appears only when its data exists.
export function renderCastJson(
	resolved: ResolvedCast,
	username: string,
	hash: string,
	origin: string,
): {
	status: 200 | 404 | 503;
	body: Record<string, unknown>;
	retryAfter?: "60";
} {
	if (resolved.kind === "not-found") {
		return { status: 404, body: { error: "cast not found" } };
	}
	if (resolved.kind === "unreachable") {
		return {
			status: 503,
			body: { error: "cast data temporarily unavailable" },
			retryAfter: "60",
		};
	}
	const { cast, unfurlMap, quotes, signed } = resolved;

	// Identity law: the author handle is the primary (fname first); absent
	// user degrades to the route input.
	const primary = primaryHandle(cast.user, username);
	const author: Record<string, unknown> = {
		username: primary,
	};
	if (cast.user?.displayName !== undefined) {
		author.displayName = cast.user.displayName;
	}
	const fid = cast.fid ?? cast.user?.fid;
	if (fid !== undefined) author.fid = fid;

	const body: Record<string, unknown> = { author };
	if (cast.timestamp !== undefined) {
		// Shim timestamps are unix seconds.
		body.timestamp = new Date(cast.timestamp * 1000).toISOString();
	}
	if (cast.text) body.text = cast.text;

	// Image embeds, in embed order, uncapped.
	const images = imageUrlsOf(cast);
	if (images.length > 0) body.images = images;

	// The same deduped, capped-at-3 list the HTML path unfurls; a title is
	// present only when unfurl actually produced one.
	const links = urlEmbedsOf(cast).map((url) => {
		const data = unfurlMap.get(url);
		const title = data?.ogTitle ?? data?.twitterTitle;
		return title ? { url, title } : { url };
	});
	if (links.length > 0) body.links = links;

	// Quotes are never dropped (unlike the HTML card): hydrated quotes map
	// to forkcaster pointers; hydration failure or a username-less cast
	// falls back to Firefly via the embed's castId hash.
	const pointers = quoteTargetsOf(cast).map((target, i) => {
		const quote = quotes[i];
		const quotePrimary = primaryHandle(quote?.user, "");
		if (quotePrimary && quote?.hash) {
			return `${origin}/${quotePrimary}/${quote.hash}`;
		}
		return `https://firefly.social/post/farcaster/${target.hash}`;
	});
	if (pointers.length > 0) body.quotes = pointers;

	body.farcaster = `https://farcaster.xyz/${primary}/${hash}`;
	body.firefly = `https://firefly.social/post/farcaster/${cast.hash}`;

	// signed === false is the only note trigger; unknown/failed fails open.
	if (signed === false) {
		body.note =
			"author hasn't signed the social smart contract; the cast may be restricted on farcaster.xyz";
	}

	return { status: 200, body };
}
