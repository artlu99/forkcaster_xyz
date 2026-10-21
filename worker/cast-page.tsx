import { FarcasterEmbed } from "react-farcaster-embed";
import { renderToString } from "preact-render-to-string";
import { siGithub, siGithubsponsors } from "simple-icons";
import {
	type ClientDefinition,
	type TemplateVars,
	LAST_CLIENT_COOKIE,
	LAST_CLIENT_MAX_AGE,
	clientsForPage,
	deeplinkTargets,
	findClient,
	resolveTemplate,
} from "./clients.ts";
import {
	type ProviderId,
	type ProviderTiming,
	type ShimCast,
	raceCast,
	shimProvider,
} from "./cast-source.ts";

type CastData = NonNullable<Parameters<typeof FarcasterEmbed>[0]["castData"]>;

// Cast data is raced across providers (cast-source.ts — shim, haatz, snap,
// farcaster.tv); shim remains the ban-signal dependency via /signed. Snapchain
// stores casts regardless of app-level bans, so restricted accounts render
// here too. farcaster.tv wins are quote-blind and self-heal client-side
// (QUOTE_FILL_SCRIPT below).

// Shim embeds are raw message items: {url} or {castId} quotes, untyped.
// Warpcast-hosted cast images live on imagedelivery.net; external images
// usually carry an image extension. Everything else renders as a link embed.
function isImageUrl(url: string): boolean {
	return (
		/imagedelivery\.net\//i.test(url) ||
		/\.(png|jpe?g|gif|webp|avif)([?#]|$)/i.test(url)
	);
}

// Quote embeds are dropped, not rendered: the bundle reads
// quote.author.pfp.url unguarded and Shim's message-level embeds carry no
// hydrated author data, so any quote card would either crash the page or
// render as an empty shell. URL embeds render as link cards via openGraph.
function urlOpenGraph(url: string): {
	url: string;
	domain: string;
	title: string;
} {
	try {
		const parsed = new URL(url);
		return { url, domain: parsed.hostname, title: parsed.hostname };
	} catch {
		return { url, domain: "", title: "" };
	}
}

// unfurl.artlu.workers.dev enriches URL embeds with Open Graph data
// (title/description/image); owner-run, cached, CORS-open. Failures fall
// back to hostname-only cards.
type UnfurlResult = {
	ogTitle?: string;
	twitterTitle?: string;
	ogDescription?: string;
	twitterDescription?: string;
	ogImage?: Array<{ url?: string } | string>;
};

async function unfurl(
	url: string,
	env?: { UNFURL?: Fetcher },
): Promise<UnfurlResult | undefined> {
	// In production, a Worker fetching another workers.dev Worker on the same
	// account is blocked (Cloudflare error 1042) — the UNFURL service binding
	// is the sanctioned path. Local dev/tests have no live binding, so after
	// a binding failure we fall back to plain fetch, which is not subject to
	// that restriction.
	const target = `https://unfurl.artlu.workers.dev/?u=${encodeURIComponent(url)}`;
	if (env?.UNFURL) {
		try {
			const res = await env.UNFURL.fetch(target, {
				signal: AbortSignal.timeout(5000),
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
		const res = await fetch(target, { signal: AbortSignal.timeout(5000) });
		if (!res.ok) return undefined;
		return (await res.json().catch(() => undefined)) as
			| UnfurlResult
			| undefined;
	} catch {
		return undefined;
	}
}

// Quote embeds are hydrated through Shim /h/{fullHash} (message embeds carry
// the full hash). Hydrated quotes map through toCastData, which provides the
// author.pfp the bundle reads unguarded. Hydration failure drops the quote —
// old casts get pruned from Snapchain when storage lapses.
async function fetchQuote(hash: string): Promise<ShimCast | undefined> {
	try {
		const res = await fetch(`https://shim.artlu.xyz/h/${hash}`, {
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return undefined;
		const data = (await res.json().catch(() => undefined)) as {
			cast?: ShimCast;
		};
		return data?.cast ?? undefined;
	} catch {
		return undefined;
	}
}

function toCastData(
	cast: ShimCast,
	unfurled?: Map<string, UnfurlResult | undefined>,
	quotes?: Array<ShimCast | undefined>,
): CastData {
	const images: Array<{
		type: string;
		url: string;
		sourceUrl: string;
		alt: string;
	}> = [];
	const urls: Array<{ type: string; openGraph: Record<string, string | boolean> }> = [];
	for (const embed of cast.embeds ?? []) {
		if (embed.castId?.hash) continue;
		if (embed.url && isImageUrl(embed.url)) {
			images.push({ type: "image", url: embed.url, sourceUrl: embed.url, alt: "" });
		} else if (embed.url) {
			urls.push({
				type: "url",
				openGraph: openGraphFor(embed.url, unfurled?.get(embed.url)),
			});
		}
	}
	const quoteCasts: CastData[] = [];
	for (const quote of quotes ?? []) {
		// Recursion depth 1: hydrated quotes render without their own quotes.
		if (quote?.hash) quoteCasts.push(toCastData(quote));
	}
	// The embed bundle reads e.recasts.count and e.tags.length unguarded, and
	// Shim's message data carries no engagement counts — stub them with zeros
	// so rendering can't crash. The zero-count stats row itself is stripped
	// from the SSR output after render (STATS_ROW below).
	return {
		hash: cast.hash,
		text: cast.text,
		timestamp: cast.timestamp === undefined ? undefined : cast.timestamp * 1000,
		author: {
			fid: cast.user?.fid,
			username: cast.user?.username,
			displayName: cast.user?.displayName,
			pfp: { url: cast.user?.pfpUrl },
			profile: cast.user?.bio ? { bio: { text: cast.user.bio } } : undefined,
		},
		embeds: { images, urls, casts: quoteCasts },
		replies: { count: 0 },
		reactions: { count: 0 },
		recasts: { count: 0 },
		tags: [],
	};
}

function openGraphFor(
	url: string,
	data?: UnfurlResult,
): Record<string, string | boolean> {
	const title = data?.ogTitle ?? data?.twitterTitle ?? urlOpenGraph(url).title;
	const description = data?.ogDescription ?? data?.twitterDescription;
	const first = data?.ogImage?.[0];
	const image = typeof first === "string" ? first : first?.url;
	return {
		url,
		domain: urlOpenGraph(url).domain,
		title,
		...(description ? { description } : {}),
		...(image ? { image, useLargeImage: true } : {}),
	};
}

function escapeHtml(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

// Collapse newlines/whitespace and truncate for meta description attributes.
function toDescription(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 280 ? `${flat.slice(0, 279)}…` : flat;
}

// The bundle renders a replies/recasts/likes row from engagement data the
// Shim doesn't carry — without the toCastData zero stubs rendering would
// crash, with them it would always show hardcoded zeros. Strip the row from
// the SSR output; the Farcaster logo in the same container stays. The stats
// <ul> is the only <ul> in the card and contains no user text, so matching
// on the container class is exact. The replacement re-opens the container
// with data attributes so the client-side live-stats script can find it.
const STATS_ROW = /(<div class="farcaster-embed-stats">)<ul>[\s\S]*?<\/ul>/;

// Live engagement counts, fetched client-side so the SSR path stays
// Shim-only and no fake numbers are ever shipped. farcaster.tv (unofficial
// Warpcast client API) sends access-control-allow-origin: * and answers for
// unsigned/banned authors too, with exact reply/like/recast counts. Any
// failure leaves the row absent — stats are decoration, not content. Only
// the static icons use innerHTML; remote values go through textContent.
const LIVE_STATS_SCRIPT = `<script>
(function () {
  var slot = document.querySelector(".farcaster-embed-stats[data-username]");
  if (!slot) return;
  var u = slot.getAttribute("data-username") || "";
  var h = slot.getAttribute("data-hash") || "";
  if (!u || !/^0x[0-9a-fA-F]+$/.test(h)) return;
  fetch("https://farcaster.tv/" + encodeURIComponent(u) + "/" + h)
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      var casts = j && j.result && j.result.casts;
      if (!casts) return;
      var c = null;
      for (var i = casts.length - 1; i >= 0; i--) {
        if (casts[i] && typeof casts[i].hash === "string" && casts[i].hash.indexOf(h) === 0) {
          c = casts[i];
          break;
        }
      }
      if (!c) return;
      var replies = c.replies && c.replies.count;
      var recasts = c.combinedRecastCount != null ? c.combinedRecastCount : c.recasts && c.recasts.count;
      var likes = c.reactions && c.reactions.count;
      if (replies == null && recasts == null && likes == null) return;
      var fmt = function (v) {
        return typeof v === "number" && isFinite(v) ? v.toLocaleString("en-US") : "0";
      };
      var icons = {
        reply: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>',
        recast: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2.1l4 4-4 4"></path><path d="M3 12.2v-2a4 4 0 0 1 4-4h12.8M7 21.9l-4-4 4-4"></path><path d="M21 11.8v2a4 4 0 0 1-4 4H4.2"></path></svg>',
        like: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06 1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>'
      };
      var href = "https://farcaster.xyz/" + u + "/" + h;
      var ul = document.createElement("ul");
      [[icons.reply, replies], [icons.recast, recasts], [icons.like, likes]].forEach(function (it) {
        var a = document.createElement("a");
        a.className = "farcaster-embed-stats-link";
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener";
        var span = document.createElement("span");
        span.textContent = fmt(it[1]);
        a.innerHTML = it[0];
        a.appendChild(span);
        var li = document.createElement("li");
        li.appendChild(a);
        ul.appendChild(li);
      });
      slot.insertBefore(ul, slot.firstChild);
    })
    .catch(function () {});
})();
</script>`;

// Remembers the visitor's client choice: a delegated click listener
// writes the last-used client id into a year-long cookie, which the
// worker reads on the next request to badge that client's pill.
// Without JS nothing breaks — links work, the badge just stays where
// the server last rendered it.
const CLIENT_SCRIPT = `<script>
(function () {
  document.addEventListener("click", function (e) {
    var el = e.target;
    while (el && el !== document) {
      var id = el.getAttribute && el.getAttribute("data-client");
      if (id) {
        document.cookie = "${LAST_CLIENT_COOKIE}=" + encodeURIComponent(id) +
          ";path=/;max-age=${LAST_CLIENT_MAX_AGE};SameSite=Lax";
        return;
      }
      el = el.parentNode;
    }
  });
})();
</script>`;

// Native-target handling for mobile: on coarse-pointer devices, a click
// on a pill that carries a native target attempts the app first and
// falls back to the pill's web href if the page is still visible after
// the attempt (app opened ⇒ page hidden ⇒ no fallback). Android prefers
// data-intent (Chrome handles the fallback natively); everything else
// uses data-scheme. Desktop and no-JS visitors just follow the web
// href; the SSR HTML is byte-identical for every device — no UA
// sniffing on the server, only a client-side transport choice. Emitted
// only when at least one rendered client has a native target.
const DEEPLINK_SCRIPT = `<script>
(function () {
  if (!window.matchMedia("(pointer: coarse)").matches) return;
  var android = /android/i.test(navigator.userAgent);
  document.addEventListener("click", function (e) {
    var el = e.target;
    while (el && el !== document) {
      var intent = android ? el.getAttribute && el.getAttribute("data-intent") : null;
      var target = intent || (el.getAttribute && el.getAttribute("data-scheme"));
      if (target) {
        e.preventDefault();
        var opened = false;
        var hide = function () { opened = true; };
        document.addEventListener("visibilitychange", hide, { once: true });
        window.addEventListener("pagehide", hide, { once: true });
        window.location.href = target;
        setTimeout(function () {
          if (!opened && !document.hidden) window.location.href = el.getAttribute("href");
        }, 1800);
        return;
      }
      el = el.parentNode;
    }
  });
})();
</script>`;

// Quote-card fill-in for partial wins: farcaster.tv drops quote embeds,
// so such pages ship without quote cards and this script pulls the
// shim-resolved SSR fragment (?embeds=quotes) into the page — the same
// silent-degradation contract as the live-stats script. Bots and no-JS
// visitors keep the OG-complete page; no server cache is involved.
const QUOTE_FILL_SCRIPT = `<script>
(function () {
  var slot = document.querySelector(".farcaster-embed");
  if (!slot) return;
  fetch(location.pathname + "?embeds=quotes")
    .then(function (r) { return r.ok ? r.text() : null; })
    .then(function (html) {
      if (!html || !html.trim()) return;
      slot.insertAdjacentHTML("afterend", html);
    })
    .catch(function () {});
})();
</script>`;

// Exported for clients.test.ts (pill markup with/without native targets).
export function clientPill(
	client: ClientDefinition,
	vars: TemplateVars,
	isLast: boolean,
): string {
	const href = resolveTemplate(client.web as string, vars);
	const targets = deeplinkTargets(client, vars);
	const native =
		(targets.intent ? ` data-intent="${escapeHtml(targets.intent)}"` : "") +
		(targets.scheme ? ` data-scheme="${escapeHtml(targets.scheme)}"` : "");
	return (
		`<a class="pill client-pill" href="${escapeHtml(href)}" data-client="${escapeHtml(client.id)}"${native}>` +
		`<img class="pill-logo" src="${escapeHtml(client.logoUrl)}" alt="" width="16" height="16" />` +
		`${escapeHtml(client.title)}` +
		(isLast ? `<span class="pill-badge">last used</span>` : "") +
		`</a>`
	);
}

// The "Open in …" action row, rendered from the client registry. One
// pill per client; the pill whose id matches the last-used cookie
// carries the badge. Suppression (signed rule, unsatisfied placeholders
// like {fid}) is decided by clientsForPage; here signed is already
// reduced to pass/fail-open.
function clientActionsHtml(
	vars: TemplateVars,
	signed: boolean,
	lastClientId: string | undefined,
): string {
	const last = findClient(lastClientId);
	const offered = clientsForPage(signed, vars);
	const pills = offered
		.map((client) => clientPill(client, vars, last !== undefined && client.id === last.id))
		.join("\n");
	// The mobile deeplink script ships only when a rendered client
	// actually has a native target — zero bytes otherwise.
	const hasNative = offered.some((client) =>
		Object.keys(deeplinkTargets(client, vars)).length > 0,
	);
	return `<p class="actions">${pills}</p>${hasNative ? DEEPLINK_SCRIPT : ""}`;
}

function shell(
	title: string,
	bodyHtml: string,
	og?: {
		ogTitle: string;
		description?: string;
		image?: string;
		largeImage?: boolean;
	},
	clientScript?: string,
	canonicalUrl?: string,
): string {
	const canonicalMeta = canonicalUrl
		? `<link rel="canonical" href="${escapeHtml(canonicalUrl)}" />`
		: "";
	const meta = og
		? [
				`<meta property="og:site_name" content="forkcaster" />`,
				`<meta property="og:type" content="article" />`,
				`<meta property="og:title" content="${escapeHtml(og.ogTitle)}" />`,
				...(canonicalUrl
					? [`<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`]
					: []),
				`<meta name="twitter:card" content="${og.largeImage && og.image ? "summary_large_image" : "summary"}" />`,
				`<meta name="twitter:title" content="${escapeHtml(og.ogTitle)}" />`,
				og.description
					? `<meta property="og:description" content="${escapeHtml(og.description)}" />`
					: "",
				og.description
					? `<meta name="twitter:description" content="${escapeHtml(og.description)}" />`
					: "",
				og.image
					? `<meta property="og:image" content="${escapeHtml(og.image)}" />`
					: "",
				og.image
					? `<meta property="og:image:alt" content="${escapeHtml(og.ogTitle)}" />`
					: "",
				og.image
					? `<meta name="twitter:image" content="${escapeHtml(og.image)}" />`
					: "",
			]
				.filter(Boolean)
				.join("\n")
		: "";
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
${canonicalMeta}
${meta}
<link rel="alternate" type="application/json" href="?format=json" />
<link rel="stylesheet" href="/farcaster-embed.css" />
<style>
:root {
  color-scheme: light dark;
  --bg: #fbfbfa;
  --ink: #101014;
  --muted: #77747e;
  --line: #e8e6e3;
  --accent: #7f32e3;
  --accent-soft: #ede7fa;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e0e12;
    --ink: #f0eff2;
    --muted: #77747e;
    --line: #26262c;
    --accent: #c1b0ff;
    --accent-soft: #241c38;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 16px/1.6 system-ui, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
.site-header, main, .site-footer {
  max-width: 672px;
  margin: 0 auto;
  padding-inline: 20px;
}
.site-header { padding-top: 24px; padding-bottom: 20px; }
.wordmark {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
  text-decoration: none;
}
.wordmark:hover { color: var(--ink); }
.wordmark b { color: var(--accent); font-weight: 600; }
main { padding-bottom: 8px; }
.notice { color: var(--muted); font-size: 14px; margin: 18px 0 0; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 20px 0 0; }
.pill {
  display: inline-block;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 8px 16px;
  color: var(--ink);
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  transition: border-color 0.15s ease, background-color 0.15s ease,
    color 0.15s ease;
}
.pill:hover, .pill:focus-visible {
  border-color: var(--accent);
  color: var(--accent);
  background: transparent;
}
.client-pill {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.pill-logo {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  flex: none;
}
.pill-badge {
  position: absolute;
  top: -8px;
  right: 10px;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  line-height: 1.4;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--bg);
  pointer-events: none;
}
.site-footer {
  margin-top: 20px;
  padding-top: 14px;
  padding-bottom: 32px;
  border-top: 1px solid var(--line);
  display: flex;
  align-items: center;
  gap: 16px;
}
.site-footer a {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
  text-decoration: none;
}
.site-footer svg {
  width: 14px;
  height: 14px;
  fill: currentColor;
}
.site-footer a:hover, .site-footer a:focus-visible { color: var(--ink); }
</style>
</head>
<body>
<header class="site-header">
  <a class="wordmark" href="/">forkcaster<b>.</b></a>
</header>
<main>
${bodyHtml}
</main>
<footer class="site-footer">
  <a href="https://github.com/artlu99/forkcaster_xyz">${siGithub.svg}MIT license</a>
  <a href="https://github.com/artlu99/forkcaster_xyz/tree/main?tab=contributing-ov-file">${siGithubsponsors.svg}Contributing</a>
</footer>
${clientScript ?? ""}
</body>
</html>`;
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
	lastClientId?: string,
	partial = false,
	primaryOrigin?: string,
): string {
	// signed === false means the author hasn't accepted Farcaster's social
	// smart contract (Network Code) — their profile is read-only/banned on
	// farcaster.xyz, so the registry's requiresSigned clients (farcaster)
	// are suppressed. The embed itself still renders for everyone.
	const notice =
		signed === false
			? `<p class="notice">The author hasn't signed the social smart contract — the cast may be restricted on farcaster.xyz.</p>`
			: "";
	const actions = clientActionsHtml(vars, signed, lastClientId);
	// Dual-serve canonicalization: every host renders the same page, but
	// points at the primary origin so link equity and unfurlers agree.
	const canonicalUrl = primaryOrigin
		? `${primaryOrigin}/${encodeURIComponent(vars.username)}/${vars.hash}`
		: undefined;
	return shell(
		`${vars.username}/${vars.hash} · forkcaster`,
		`${cardHtml}${notice}${actions}`,
		og,
		`${CLIENT_SCRIPT}${LIVE_STATS_SCRIPT}${partial ? QUOTE_FILL_SCRIPT : ""}`,
		canonicalUrl,
	);
}

function linkOnlyPage(
	username: string,
	hash: string,
	lastClientId?: string,
): string {
	// No provider resolved the cast: signed state is unknown, which fails
	// open — every registry client is offered. The route hash is used as-is
	// (it may be short-form); the {fullHash} slot degrades to it. No fid is
	// known, so any future fid-gated client would be skipped here.
	return shell(
		`${username}/${hash} · forkcaster`,
		`<p class="notice">Cast data is temporarily unavailable.</p>${clientActionsHtml(
			{ username, hash, fullHash: hash },
			true,
			lastClientId,
		)}`,
		undefined,
		CLIENT_SCRIPT,
	);
}

function notFoundPage(username: string, hash: string): string {
	return shell(
		`${username}/${hash} · forkcaster`,
		`<p class="notice">Cast not found: ${username}/${hash}. The username or hash may be wrong, or the cast was deleted.</p>`,
	);
}

// URL embeds destined for unfurl enrichment: deduped, capped at 3.
// Shared by resolve (which performs the unfurls) and the JSON renderer
// (which must describe exactly the same list).
function urlEmbedsOf(cast: ShimCast): string[] {
	return Array.from(
		new Set(
			(cast.embeds ?? [])
				.map((embed) => embed.url)
				.filter((u): u is string => typeof u === "string" && !isImageUrl(u)),
		),
	).slice(0, 3);
}

// Quote embeds destined for Shim /h hydration: capped at 3. Same sharing
// story as urlEmbedsOf: resolve hydrates, the JSON renderer pairs against
// the results position by position.
function quoteHashesOf(cast: ShimCast): string[] {
	return (cast.embeds ?? [])
		.map((embed) => embed.castId?.hash)
		.filter((h): h is string => typeof h === "string")
		.slice(0, 3);
}

// Image embed URLs in embed order. The HTML renderer uses the first for
// og:image; the JSON renderer lists all of them.
function imageUrlsOf(cast: ShimCast): string[] {
	return (cast.embeds ?? [])
		.map((embed) => embed.url)
		.filter((u): u is string => typeof u === "string" && isImageUrl(u));
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
	const quoteHashes = quoteHashesOf(foundCast);
	const unfurls = Promise.allSettled(
		urlEmbeds.map((u) => unfurl(u, env)),
	);
	const quoteFetches = Promise.allSettled(
		quoteHashes.map((h) => fetchQuote(h)),
	);

	// Has the author signed the social smart contract? Unknown (null)
	// fails open: the farcaster.xyz link is shown unless Shim says no.
	// The check is time-boxed to the HTML box so a slow shim can't stall a
	// fast partial win; JSON waits fully (strict path).
	let signed: boolean | null = null;
	const fid = foundCast.fid ?? foundCast.user?.fid;
	if (fid !== undefined) {
		const signedPromise = (async (): Promise<boolean | null> => {
			try {
				const res = await fetch(`https://shim.artlu.xyz/signed/${fid}`, {
					signal: AbortSignal.timeout(5000),
				});
				if (res.ok) {
					const data = (await res.json().catch(() => ({}))) as {
						signed?: boolean;
					};
					if (typeof data.signed === "boolean") return data.signed;
				}
			} catch {
				// Signed-check unavailable — fail open.
			}
			return null;
		})();
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
	lastClientId?: string,
	primaryOrigin?: string,
): Promise<{ status: 200 | 404; html: string }> {
	if (resolved.kind === "not-found") {
		return { status: 404, html: notFoundPage(username, hash) };
	}
	if (resolved.kind === "unreachable") {
		return { status: 200, html: linkOnlyPage(username, hash, lastClientId) };
	}
	const { cast, unfurlMap, quotes, signed, partial } = resolved;
	try {
		const cardHtml = renderToString(
			(await FarcasterEmbed({
				username,
				hash,
				castData: toCastData(cast, unfurlMap, quotes),
			})) as never,
		).replace(
			STATS_ROW,
			() =>
				`<div class="farcaster-embed-stats" data-username="${escapeHtml(username)}" data-hash="${escapeHtml(hash)}">`,
		);
		// OG/Twitter meta so Telegram, Discord, iMessage etc. unfurl the
		// cast: author handle as title, cast text as description, first
		// image embed (else the avatar) as image.
		const handle = cast.user?.username ?? username;
		const ogTitle = cast.user?.displayName
			? `${cast.user.displayName} (@${handle})`
			: `@${handle}`;
		const firstImage = imageUrlsOf(cast)[0];
		const og = {
			ogTitle,
			description: cast.text ? toDescription(cast.text) : undefined,
			image: firstImage ?? cast.user?.pfpUrl,
			largeImage: firstImage !== undefined,
		};
		const vars: TemplateVars = {
			username,
			hash,
			fullHash: cast.hash,
			// Same fallback the signed check uses; undefined on fid-less
			// casts, which gates any fid-requiring client template.
			fid: cast.fid ?? cast.user?.fid,
		};
		return {
			status: 200,
			// signed === false is the only hide trigger; unknown fails open.
			html: castPage(
				vars,
				cardHtml,
				signed !== false,
				og,
				lastClientId,
				partial,
				primaryOrigin,
			),
		};
	} catch {
		// Embed rendering failed — degrade to links instead of erroring.
		return { status: 200, html: linkOnlyPage(username, hash) };
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
		AbortSignal.timeout(5000),
	);
	if (outcome.kind === "error") return { status: 503, html: "" };
	if (outcome.kind === "miss") return { status: 404, html: "" };
	const quoteHashes = quoteHashesOf(outcome.cast);
	const quoteFetches = await Promise.allSettled(
		quoteHashes.map((h) => fetchQuote(h)),
	);
	const cards: string[] = [];
	for (const settled of quoteFetches) {
		const quote = settled.status === "fulfilled" ? settled.value : undefined;
		if (!quote?.hash) continue;
		try {
			const quoteUsername = quote.user?.username ?? username;
			const card = renderToString(
				(await FarcasterEmbed({
					username: quoteUsername,
					hash: quote.hash,
					castData: toCastData(quote),
				})) as never,
			)
				// Quote cards carry no live-stats slot: drop the zero-stub row.
				.replace(STATS_ROW, "$1");
			cards.push(card);
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

	const author: Record<string, unknown> = {
		username: cast.user?.username ?? username,
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
	const pointers = quoteHashesOf(cast).map((embedHash, i) => {
		const quote = quotes[i];
		if (quote?.user?.username && quote.hash) {
			return `${origin}/${quote.user.username}/${quote.hash}`;
		}
		return `https://firefly.social/post/farcaster/${embedHash}`;
	});
	if (pointers.length > 0) body.quotes = pointers;

	body.farcaster = `https://farcaster.xyz/${username}/${hash}`;
	body.firefly = `https://firefly.social/post/farcaster/${cast.hash}`;

	// signed === false is the only note trigger; unknown/failed fails open.
	if (signed === false) {
		body.note =
			"author hasn't signed the social smart contract; the cast may be restricted on farcaster.xyz";
	}

	return { status: 200, body };
}
