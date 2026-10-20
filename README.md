# forkcaster — agent brief

> Audience: coding agents. Prefer facts over prose. Update this file when architecture or commands change.

## Intent

Micro-site that mirrors Farcaster cast URLs for sharing without the Farcaster app.

- Pattern: `/{username}/{castHash}` where `castHash` matches `0x[0-9a-fA-F]+` — short or full form
- Examples: `/zoo/0x895ecc74` and `/decent-artlu/0xbb54368f` → SSR cast card + links
- Data: Shim (`https://shim.artlu.xyz/wc/{username}/{hash}`) — an owner-run cached reader for the Farcaster Snapchain. One call returns the full cast, full hash included.
- Missing cast (Shim reports none) → 404 page; Shim unreachable → link-only page (200)
- Banned accounts: embeds render for everyone — but farcaster.xyz hides unsigned authors. Since Oct 15, 2026 (Network School takeover), accounts must accept the "social smart contract" (Network Code); acceptance is an on-chain access NFT. Shim exposes it: `GET https://shim.artlu.xyz/signed/{fid}` → `{"signed":true|false}`. Unsigned authors: the farcaster.xyz footer link is suppressed and only the Firefly link is shown (the check fails open — unknown state shows the link).
- farcaster.tv is deliberately not used for cast data: unofficial third party, rules unknown. react-farcaster-embed's own default endpoint is farcaster.tv — always pass `castData` so it never fetches. Sole exception: the live stats row (replies/recasts/likes) is fetched **client-side** from farcaster.tv — it sends `access-control-allow-origin: *` and answers for unsigned authors too; any failure just leaves the row absent

## Stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Runtime / package mgr | Bun | lockfile: `bun.lock`; scripts use `bun run` |
| UI (landing) | Preact 11 | SPA assets; entry `src/main.tsx` |
| Cast pages | Hono on Cloudflare Worker | SSR in `worker/` |
| Cast data | Shim API | `/wc/{username}/{shortHash}` → full cast; see Mapping below |
| URL embed cards | unfurl.artlu.workers.dev | called via the `UNFURL` **service binding** (workers.dev→workers.dev fetch is blocked, CF error 1042); `GET /?u={url}` → OG title/description/image (cached, fails open to hostname-only) |
| Cast embed | react-farcaster-embed | rendering only — `castData` always supplied, never fetches |
| Live stats | client-side script → farcaster.tv | `LIVE_STATS_SCRIPT` in `cast-page.tsx`; fills the SSR-stripped stats slot from the browser; fails silent (row absent); SSR data path stays Shim-only |
| SSR | preact-render-to-string | after `await FarcasterEmbed({ castData })` |
| Bundler | Vite 8 | `@preact/preset-vite` + `@cloudflare/vite-plugin` |
| Lint | Biome | `bun run lint` |
| Typecheck | `bun check` | tsc-compatible, built into Bun; no `typescript` pkg |
| Tests | bun:test | `bun test worker/cast-route.test.ts` |

## Commands

```sh
bun install
bun run dev          # vite (CF plugin; local worker + assets)
bun run build        # vite build → dist/
bun run typecheck    # bun check (tsc-compatible; reads tsconfig*.json)
bun run preview      # build + vite preview
bun run deploy       # build + wrangler deploy
bun run lint         # biome lint .
bun test             # integration tests (cast route)
bun run cf-typegen   # wrangler types → worker-configuration.d.ts
```

## Layout

```
/
├── index.html                 # SPA shell → /src/main.tsx
├── vite.config.ts             # preact + cloudflare + react→preact aliases
├── wrangler.jsonc             # main=worker/index.ts; not_found_handling=none
├── public/farcaster-embed.css # linked from SSR HTML
├── public/logos/              # per-client marks for the action row
├── worker/
│   ├── index.ts               # Hono app; export { app }; default { fetch }
│   ├── clients.ts             # client registry (schema, URLs, logos, cookie)
│   ├── cast-page.tsx          # Shim fetch → CastData mapping → SSR / 404 / link fallback
│   ├── cast-route.test.ts     # bun:test; mock.module + exact-URL fetch mock
│   └── shims/server-only.ts   # empty stub for Next.js marker package
└── src/                       # landing only (App.tsx)
```

## Routes

| Path | Handler | Response |
| --- | --- | --- |
| `/` | static asset `index.html` | landing SPA |
| `/api/` | Hono | `{ "name": "Cloudflare" }` |
| `/:username/:hash` (`0x…`) | Hono SSR | HTML: 200 cast card + OG/Twitter meta (title = author handle, description = cast text, image = first image embed or avatar) + registry-driven client action row (see "Client registry" below); unsigned author (`/signed/{fid}` false): `requiresSigned` clients (farcaster) suppressed; 404 when Shim reports no such cast; 200 link-only when Shim is unreachable |
| `/:username/:hash?format=json` (or `Accept: application/json`) | Hono JSON | Strict-status agent variant — see "Agent JSON variant" below |
| other missing paths | worker 404 / no SPA fallback | `not_found_handling: none` |

## Agent JSON variant (`?format=json`)

**Shipped.** Resolve once (Shim fetch + unfurl + quote hydration + signed check → `resolveCast()`), render twice — `renderCastHtml()` / `renderCastJson()` in `worker/cast-page.tsx`. The return type morphs on the asker.

Negotiation — explicit first, no UA sniffing:

| Signal | Response |
| --- | --- |
| `?format=json` query param | JSON (documented contract; wins over Accept) |
| `Accept: application/json` | JSON |
| anything else (browsers, `*/*`, chat link-preview bots) | HTML |

Decisions:

- **JSON only** — no kv/plain-text form (kv is lossy; JSON's token overhead is negligible).
- **Strict statuses on JSON, lenient on HTML** (deliberate divergence): JSON → 404 when Shim reports no such cast, 503 + `Retry-After: 60` when Shim is unreachable. HTML keeps its 404 page / 200 link-only page. Agents handle status codes better than rendered fallbacks.
- **Availability-gated payload** — a field appears only when its data exists: author, ISO 8601 timestamp, text, image embed URLs, URL embeds (unfurl title appended when unfurl succeeded, bare URL otherwise), quote embeds, canonical farcaster.xyz + Firefly links.
- **Quotes are pointers, never dropped**: hydrated quote → forkcaster URL (requires the username from the hydrated cast); hydration failure → Firefly full-hash URL (quote embeds carry `{fid, hash}`, no username). HTML's rendering constraints (unguarded `author.pfp.url`) don't apply to JSON — failed hydration degrades to a URL the agent can fetch.
- **Ban signal**: `signed: false` emits a short note field; unknown/failed check fails open silently (same semantics as the HTML footer link).
- **Discoverability**: HTML pages emit `<link rel="alternate" type="application/json" href="?format=json">`.
- **Deferred**: UA-allowlist morphing (GPTBot, ClaudeBot, …) as a later progressive enhancement. Must stay an allowlist — Telegram/Discord/iMessage preview bots must keep receiving HTML + OG meta.
- No page-level caching today (Shim is the cache); if edge caching is ever added, the variant must join the cache key.

## Client registry (action row, last-used badge)

The cast page's "Open in …" pills are rendered from a data registry, `worker/clients.ts` — adding a client is a data change only.

- **Schema** (`ClientDefinition`): `id` (stable slug, cookie value), `title`, `logoUrl` (served from `public/logos/`), `web` (per-cast https template), `deeplink` (**reserved** — custom-scheme per-cast formats are still unverified; not rendered), `requiresSigned` (suppressed only on a known `signed:false`; unknown fails open).
- **Templates** interpolate `{username}`, `{hash}` (route-form, short or full) and `{fullHash}` (Shim-resolved). The engine also supports an optional `{fid}` placeholder with a `missingVars` gate (a client needing it is skipped when the value is absent) — reserved for future entries. Values are percent-encoded at resolution and HTML-escaped at render.
- **Mobile deeplinks vs web targets**: one pill per client; the `href` is always the `web` URL. Universal links already open installed apps on mobile — verified per client: Farcaster's AASA claims all farcaster.xyz paths, Firefly's AASA explicitly claims `/post/*` (Android: `com.farcaster.mobile` and `io.dimension.firefly` confirmed via assetlinks.json). A structured `deeplink: { scheme, androidPackage? }` adds a native attempt for mobile only: the pill gains `data-scheme` + `data-intent` (the intent:// form carries `S.browser_fallback_url` = the web URL), and a conditional script intercepts clicks on coarse-pointer devices — Android uses the intent (Chrome-native fallback), everything else attempts the scheme and falls back to the web href if the app didn't open (~1.8s, visibility-aware). The script ships only when a rendered client actually has a `deeplink`. **Farcaster currently ships `farcaster://{username}/{fullHash}` — verified against the open-source app** ([farcasterxyz/client](https://github.com/farcasterxyz/client)): the app rewrites `farcaster://` to `https://farcaster.xyz/` and routes the rest as a web path, where cast URLs are `/{username}/{hash}` accepting full or short (≥8 hex) hashes; the legacy `/casts/:fname/:hash` route is gone. **Firefly ships no scheme** — none is documented anywhere; its web URL is already app-linked on both platforms.
- **Roster — all three clients have verified per-cast URLs**: farcaster (`/{username}/{hash}`), firefly and neynar (full-hash based; neynar verified against `fc-clients-cast-action`, `src/lib/deeplink.ts`).
- **Last-used cookie**: any click on a `data-client` pill writes `fc_client=<id>` (1 year, `SameSite=Lax`) via `CLIENT_SCRIPT`; on the next request the worker reads it and SSRs a small "last used" badge onto that client's pill. Unknown cookie values render nothing (registry whitelist). No cookie ⇒ no badge; no JS ⇒ links still work, the badge just doesn't move. Cookie-conditional HTML: if an edge cache is ever added, the badge must join the cache key.
- **Logos**: self-hosted in `public/logos/`, one file per client — farcaster is the official simple-icons mark (`siFarcaster`); firefly and neynar are official favicons.

## Shim → CastData mapping

Shim returns raw Snapchain message data; `toCastData()` in `worker/cast-page.tsx` adapts it for react-farcaster-embed:

- `timestamp` is unix **seconds** → multiplied by 1000 (the embed does `new Date(ts)`)
- `embeds` are untyped `{url}` / `{castId}` items → bucketed into `images` / `urls` / `casts`; image heuristic = `imagedelivery.net` host or image extension. **Quotes are hydrated** through Shim `GET /h/{fullHash}` (depth 1) and mapped like any cast; hydration failure (e.g. pruned casts) drops the quote. URL embeds render as link cards via `openGraph` (see unfurl above)
- message-level data has no engagement counts → `replies`/`reactions`/`recasts` stubbed to `{ count: 0 }` and `tags: []` — the embed bundle reads `e.recasts.count` and `e.tags.length` **unguarded** and crashes without them (it also reads `quote.author.pfp.url` unguarded — never emit quotes without hydrated authors). The stubs would render as hardcoded zero counters, so the stats row is stripped from the SSR output (`STATS_ROW`); the Farcaster logo in the same container stays
- `author` mapped from `user` (`pfpUrl` → `pfp.url`, `bio` → `profile.bio.text`)

## Conventions for agents

- **Preact, not React** for first-party code. Vite aliases map `react*` → preact for the embed lib.
- **Cast routing is server-side (Hono)**, not client-side routing.
- **Tests**: `mock.module("server-only"|react*)` before importing `./index.ts`; mock `globalThis.fetch` by exact Shim URL — unexpected URLs throw, which is how fallback paths get tested.
- **TS worker**: `jsxImportSource: preact`; relative imports need `.tsx` extensions (`nodenext`); tests excluded from `tsconfig.worker.json`.
- **Secrets**: `.env*` / `.dev.vars*` gitignored.

## Key files

| Task | Touch |
| --- | --- |
| Shim fetch / mapping / SSR fallbacks | `worker/cast-page.tsx` |
| Routes | `worker/index.ts` |
| Aliases | `vite.config.ts`, `tsconfig.worker.json` paths |
| Landing | `src/App.tsx` |
| Deploy / CF | `wrangler.jsonc` |

## Status

Shim-only SSR data path; live stats fetched client-side from farcaster.tv (the sole farcaster.tv touchpoint). Agent JSON variant (`?format=json`) shipped. Optional: deploy.
