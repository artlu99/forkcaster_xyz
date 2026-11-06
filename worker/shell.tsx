// The shared page frame: head/meta, the stylesheet, header and footer —
// used by cast pages and /transparency alike. Escape everything that
// touches user or upstream text with escapeHtml; cast text is untrusted.

import { siGithub, siGithubsponsors, siOpenaccess } from "simple-icons";
import { iconMark } from "../shared/icon-mark.ts";
import type { FarcatPreview, SiteChrome } from "./site-chrome.ts";

// Shared with transparency.tsx — the only escaper for hand-built HTML.
export function escapeHtml(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

// Shared with the identity cards (profiles, channels): one date style for
// every "Created"/cast-date fact. NaN/out-of-range input renders "" (the
// field is then omitted — never a thrown render).
export function formatDate(unixSeconds: number): string {
	const date = new Date(unixSeconds * 1000);
	if (Number.isNaN(date.getTime())) return "";
	return new Intl.DateTimeFormat("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
	}).format(date);
}

// Shared with the identity cards: one whitespace-collapse for every
// free-text field (bios, channel descriptions) before it renders.
export function collapseText(text: string | null | undefined): string {
	return (text ?? "").replace(/\s+/g, " ").trim();
}

const SAFE_FARCAT_NAME = /^FarCats #\d+$/;
const SAFE_FARCAT_PRICE = /^\d+(?:\.\d+)? (?:ETH|WETH)$/;
const SAFE_FARCAT_HREF =
	/^https:\/\/opensea\.io\/item\/ethereum\/0x9340204616750cb61e56437befc95172c6ff6606\/\d+$/;
const SAFE_FARCAT_IMAGE =
	/^https:\/\/i2c\.seadn\.io\/ethereum\/0x9340204616750cb61e56437befc95172c6ff6606\/[a-z0-9]+\.(?:jpe?g|png|gif|webp)\?w=64&h=64$/;

/** Bottom-of-page banner. Empty unless every field matches the FarCats
 * allowlist — the preview is parsed from a third-party document. */
export function farcatChipHtml(farcat: FarcatPreview | null | undefined): string {
	if (!farcat) return "";
	if (!SAFE_FARCAT_NAME.test(farcat.name)) return "";
	if (!SAFE_FARCAT_HREF.test(farcat.href)) return "";
	if (!SAFE_FARCAT_IMAGE.test(farcat.imageUrl)) return "";
	if (farcat.priceLabel !== undefined && !SAFE_FARCAT_PRICE.test(farcat.priceLabel)) {
		return "";
	}
	const price = farcat.priceLabel
		? `<span class="farcat-price">${escapeHtml(farcat.priceLabel)}</span>`
		: "";
	return `<a class="farcat" href="${escapeHtml(farcat.href)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(farcat.imageUrl)}" alt="" width="32" height="32" /><span class="farcat-name">${escapeHtml(farcat.name)}</span>${price}</a>`;
}

export function shell(
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
	// og:type per surface: cast/transparency pages stay "article" (the
	// historical default), profiles render "profile", channel landings
	// render "website" — pass it explicitly.
	ogType: string = "article",
	// The casts skeleton page has no JSON twin: it omits the alternate link
	// instead of advertising an endpoint that would answer HTML.
	jsonAlternate = true,
	// warpcats.com passes chrome; absent keeps the forkcaster bytes.
	chrome?: SiteChrome,
): string {
	const siteName = chrome?.site === "warpcats" ? "warpcats" : "forkcaster";
	const brandedTitle =
		siteName === "warpcats" && title.endsWith(" · forkcaster")
			? `${title.slice(0, -"forkcaster".length)}warpcats`
			: title;
	const farcat = siteName === "warpcats" ? farcatChipHtml(chrome?.farcat) : "";
	const canonicalMeta = canonicalUrl
		? `<link rel="canonical" href="${escapeHtml(canonicalUrl)}" />`
		: "";
	const meta = og
		? [
				`<meta property="og:site_name" content="${siteName}" />`,
				`<meta property="og:type" content="${escapeHtml(ogType)}" />`,
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
	// Title is escaped: it embeds the route's percent-decoded username.
	return `<!doctype html>
<html lang="en" class="no-js">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(brandedTitle)}</title>
${canonicalMeta}
${meta}
${jsonAlternate ? `<link rel="alternate" type="application/json" href="?format=json" />` : ""}
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
/* Bottom strip on warpcats.com only. In document flow, under the footer,
   so it never covers the sheet or the action row. */
a.farcat {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 672px;
  margin: 0 auto;
  padding: 14px 20px 32px;
  border-top: 1px solid var(--line);
  color: var(--ink);
  text-decoration: none;
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.farcat img {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--line);
  flex: none;
}
.farcat-name { font-weight: 600; }
.farcat-price { color: var(--muted); }
a.farcat:hover, a.farcat:focus-visible { color: var(--accent); }
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
/* Pointer-class pill scoping: registry targets may carry a fine/coarse
   pointer scope (quorum: phones only — its desktop build renders no
   casts) — the scoped pills ship in the SSR HTML
   (byte-identical for every device, no UA sniffing) and CSS picks.
   pointer:none devices see both — a graceful default. */
@media (pointer: coarse) { .fine-only { display: none; } }
@media (pointer: fine) { .coarse-only { display: none; } }
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
.auto-banner, .auto-overlay {
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
  border: 1px solid var(--accent); background: var(--accent-soft);
  border-radius: 10px; padding: 10px 14px; margin: 0 0 14px; font-size: 14px;
}
.auto-banner .auto-go { color: var(--ink); text-decoration: none; }
.auto-banner .auto-go:hover { color: var(--accent); }
.auto-banner .auto-settings, .auto-overlay .auto-settings { color: var(--muted); font-size: 12px; text-decoration: none; }
.auto-overlay { border-width: 2px; border-radius: 12px; padding: 22px; }
.auto-overlay-title { font-size: 30px; font-weight: 700; margin: 0 0 12px; }
.auto-overlay-actions { display: flex; gap: 10px; flex-wrap: wrap; margin: 0; }
.auto-overlay .pill { font-size: 18px; padding: 10px 22px; }
.auto-banner .pill, .auto-overlay .pill { cursor: pointer; }
/* The client sheet (client-sheet.test.ts): the drawer-style "Open in…"
   chooser. The sheet is a <dialog> bottom sheet — top-layer rendering
   (no z-index wars, no fixed-position Safari jitter), compositor-only
   motion (transform + opacity), MD3's emphasized curve, safe-area
   padding for the home indicator. Escape and backdrop-tap close it
   natively; SHEET_SCRIPT wires the rest. */
.sheet-trigger { cursor: pointer; font: inherit; font-size: 14px; font-weight: 500; background: none; }
/* Resolution-first primary (SHELL_PREP's client-side rewrite): the
   resolved client's direct action reads as THE action — accent-bordered,
   logo included — and the sheet trigger survives as the muted "More
   apps" overflow. The SSR shell ships neither: a cookie-free page shows
   only the generic "Open this cast in…" chooser. */
.pill.sheet-open-client { border-color: var(--accent); color: var(--accent); font-weight: 600; }
.pill.sheet-more { color: var(--muted); font-size: 13px; }
dialog.sheet {
  position: fixed; inset: auto 0 0 0; margin: 0 auto;
  width: min(100%, 672px);
  /* The UA stylesheet caps modal dialogs at ~(100% - 6px) - 2em — on a
     phone that floats the sheet ~19px off each edge. Full-bleed wins. */
  max-width: none;
  border: 1px solid var(--line); border-bottom: none;
  border-radius: 20px 20px 0 0;
  background: var(--bg); color: var(--ink);
  padding: 18px 20px calc(18px + env(safe-area-inset-bottom, 0px));
  box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.18);
  transform: translateY(100%);
}
/* A closed sheet must be display:none the INSTANT close() fires: the
   sheet is position:fixed at bottom:0, and the page's own action rows
   (the profile's "Casts and replies" pill, the cast client sheet) live
   in that strip — anything rendered there eats their taps. The exit
   choreography's allow-discrete display transition defers the UA's
   display:none for the slide-out, and WebKit's half of that deal is
   broken: it has no 'overlay' property (bug 276727), so the dialog
   leaves the top layer at once while the display transition STILL
   postpones hiding — a closed sheet lingering rendered and hit-testable
   over the bottom of the page for the whole exit (and stranded there if
   the transition stalls; iOS 26 has dialog bugs in exactly this area).
   So the enter animation rides the [open] state (works everywhere via
   @starting-style below), and the exit choreography ships ONLY where
   'overlay' exists — Chromium, the sole engine where it actually works;
   WebKit's own suggested workaround for the ungraceful degradation
   (bug 289473). Everywhere else close() snaps straight to hidden. The
   explicit :not([open]) display:none restates the UA rule so engines
   without <dialog> support at all (unknown element, inline default)
   also hide the closed chooser — placed BEFORE the .no-js rule, which
   must win on equal specificity (it re-surfaces the sheet as a block). */
dialog.sheet:not([open]) { display: none; }
dialog.sheet[open] {
  transform: translateY(0);
  transition: transform 0.3s cubic-bezier(0.2, 0, 0, 1);
}
@starting-style { dialog.sheet[open] { transform: translateY(100%); } }
@supports (overlay: auto) {
  dialog.sheet {
    transition: transform 0.3s cubic-bezier(0.2, 0, 0, 1),
      overlay 0.3s allow-discrete, display 0.3s allow-discrete;
  }
}
dialog.sheet::backdrop {
  background: rgba(0, 0, 0, 0.4); opacity: 0; transition: opacity 0.3s;
}
dialog.sheet[open]::backdrop { opacity: 1; }
@starting-style { dialog.sheet[open]::backdrop { opacity: 0; } }
dialog.sheet .actions { margin: 0; }
.sheet-title {
  margin: 0 0 12px; font-size: 12px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted);
}
.sheet-pref {
  display: flex; align-items: center; gap: 10px;
  margin: 16px 0 0; padding-top: 14px; border-top: 1px solid var(--line);
  font-size: 14px; cursor: pointer;
}
.sheet-pref input {
  appearance: none; -webkit-appearance: none;
  width: 36px; height: 20px; border-radius: 999px;
  background: var(--line); position: relative; margin: 0; flex: none;
  cursor: pointer; transition: background-color 0.15s ease;
}
.sheet-pref input::after {
  content: ""; position: absolute; top: 2px; left: 2px;
  width: 16px; height: 16px; border-radius: 50%;
  background: var(--bg); box-shadow: 0 0 0 1px var(--line);
  transition: left 0.15s ease;
}
.sheet-pref input:checked { background: var(--accent); }
.sheet-pref input:checked::after { left: 18px; }
.sheet-pref input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* No-JS fallback: showModal never fires, so the sheet renders open as a
   plain block — the pills stay reachable (they are plain anchors); the
   trigger and the /prefs toggle disappear, since neither can work. The
   title stays: it labels the row that replaced the trigger. */
.no-js dialog.sheet {
  display: block; position: static; inset: auto; width: auto;
  margin: 20px 0 0; padding: 0; border: none; border-radius: 0;
  box-shadow: none; transform: none;
}
.no-js .sheet-trigger, .no-js .sheet-pref { display: none; }
@media (prefers-reduced-motion: reduce) {
  dialog.sheet, dialog.sheet::backdrop { transition: none; }
}
</style>
</head>
<body>
<header class="site-header">
  <a class="wordmark" href="/">${siteName}<b>.</b></a>
</header>
<main>
${bodyHtml}
</main>
<footer class="site-footer">
  <a href="https://github.com/artlu99/forkcaster_xyz">${iconMark(siGithub.svg)}MIT license</a>
  <a href="https://github.com/artlu99/forkcaster_xyz/tree/main?tab=contributing-ov-file">${iconMark(siGithubsponsors.svg)}Contributing</a>
  <a href="/transparency">${iconMark(siOpenaccess.svg)}Transparency</a>
</footer>
${farcat}
${clientScript ?? ""}
</body>
</html>`;
}
