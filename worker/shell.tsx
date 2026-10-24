// The shared page frame: head/meta, the stylesheet, header and footer —
// used by cast pages and /transparency alike. Escape everything that
// touches user or upstream text with escapeHtml; cast text is untrusted.

import { siGithub, siGithubsponsors, siOpenaccess } from "simple-icons";
import { iconMark } from "../shared/icon-mark.ts";

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
): string {
	const canonicalMeta = canonicalUrl
		? `<link rel="canonical" href="${escapeHtml(canonicalUrl)}" />`
		: "";
	const meta = og
		? [
				`<meta property="og:site_name" content="forkcaster" />`,
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
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
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
.auto-banner, .auto-overlay {
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
  border: 1px solid var(--accent); background: var(--accent-soft);
  border-radius: 10px; padding: 10px 14px; margin: 0 0 14px; font-size: 14px;
}
.auto-banner .auto-go { color: var(--ink); text-decoration: none; }
.auto-banner .auto-go:hover { color: var(--accent); }
.auto-banner .auto-settings, .auto-overlay .auto-settings,
.auto-chip[href="/"] { color: var(--muted); font-size: 12px; text-decoration: none; }
.auto-overlay { border-width: 2px; border-radius: 12px; padding: 22px; }
.auto-overlay-title { font-size: 30px; font-weight: 700; margin: 0 0 12px; }
.auto-overlay-actions { display: flex; gap: 10px; flex-wrap: wrap; margin: 0; }
.auto-overlay .pill { font-size: 18px; padding: 10px 22px; }
.auto-banner .pill, .auto-overlay .pill { cursor: pointer; }
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
  <a href="https://github.com/artlu99/forkcaster_xyz">${iconMark(siGithub.svg)}MIT license</a>
  <a href="https://github.com/artlu99/forkcaster_xyz/tree/main?tab=contributing-ov-file">${iconMark(siGithubsponsors.svg)}Contributing</a>
  <a href="/transparency">${iconMark(siOpenaccess.svg)}Transparency</a>
</footer>
${clientScript ?? ""}
</body>
</html>`;
}
