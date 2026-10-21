# forkcaster — agent brief

> Audience: coding agents. Prefer facts over prose. Update this file when architecture or commands change.

## Intent

Micro-site that mirrors Farcaster cast URLs for sharing without the Farcaster app.

- Pattern: `/{username}/{castHash}` where `castHash` matches `0x[0-9a-fA-F]+` — short or full form
- Examples: `/zoo/0x895ecc74` and `/decent-artlu/0xbb54368f` → SSR cast card + links
- Data: raced across providers (`worker/cast-source.ts`, rpc-racer pattern) — see "Cast source race" below. **shim** (`https://shim.artlu.xyz/wc/{username}/{hash}`, owner-run Snapchain reader with a keep-warm cron) is the completeness anchor and the sole ban-signal dependency (`/signed/{fid}`); **farcaster.tv** is fast but quote-blind; raw nodes **haatz**/`snap.farcaster.xyz:3381` are complete but need shim `/f/{username}` for the fid and a full hash. All upstream calls are capped at 5s.
- Missing cast: an authoritative miss from a complete provider (shim, haatz, snap) → 404 page; no provider resolved → link-only page (200). All upstream calls are capped at 5s (`AbortSignal.timeout`) — shim's cold sharded lookups can otherwise hang 15s+; timeout ⇒ unreachable. Strict statuses are the JSON variant's job (see below)
- Banned accounts: embeds render for everyone — but some clients hide unsigned authors. Since Oct 15, 2026 (Network School takeover), accounts must accept the "social smart contract" (Network Code); acceptance is an on-chain access NFT. Shim exposes it: `GET https://shim.artlu.xyz/signed/{fid}` → `{"signed":true|false}`. Unsigned authors: registry clients with `requiresSigned` (currently farcaster) are suppressed from the action row; the check fails open — unknown state suppresses nothing
- farcaster.tv as a **cast data** source is quote-blind (it drops `{castId}` embeds) and unofficial — it races as the partial tier only (700ms HTML box, client-side quote fill-in). react-farcaster-embed's own default endpoint is farcaster.tv — always pass `castData` so it never fetches. The live stats row (replies/recasts/likes) is still fetched **client-side** from farcaster.tv — it sends `access-control-allow-origin: *` and answers for unsigned authors too; any failure just leaves the row absent

## Stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Runtime / package mgr | Bun | lockfile: `bun.lock`; scripts use `bun run` |
| UI (landing) | Preact 11 | SPA assets; entry `src/main.tsx` |
| Cast pages | Hono on Cloudflare Worker | SSR in `worker/` |
| Cast data | Provider race (`cast-source.ts`) | shim ∥ farcaster.tv ∥ haatz ∥ snap — first validated win; completeness box for HTML, shim-only for JSON; see "Cast source race" below |
| URL embed cards | unfurl.artlu.workers.dev | called via the `UNFURL` **service binding** (workers.dev→workers.dev fetch is blocked, CF error 1042); `GET /?u={url}` → OG title/description/image (cached, fails open to hostname-only) |
| Cast embed | react-farcaster-embed | rendering only — `castData` always supplied, never fetches |
| Live stats | client-side script → farcaster.tv | `LIVE_STATS_SCRIPT` in `cast-page.tsx`; fills the SSR-stripped stats slot from the browser; fails silent (row absent); SSR data path stays Shim-only |
| SSR | preact-render-to-string | after `await FarcasterEmbed({ castData })` |
| Bundler | Vite 8 | `@preact/preset-vite` + `@cloudflare/vite-plugin` |
| Lint | Biome | `bun run lint` |
| Typecheck | `bun check` | tsc-compatible, built into Bun; no `typescript` pkg |
| Tests | bun:test | `bun test` (cast route + client registry) |

## Commands

```sh
bun install
bun run dev          # wrangler dev (local worker + assets)
bun run build        # vite build → dist/
bun run typecheck    # bun check (tsc-compatible; reads tsconfig*.json)
bun run deploy       # build + wrangler deploy
bun run lint         # biome lint .
bun test             # worker tests (cast route + client registry)
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
│   ├── cast-source.ts         # provider race: shim ∥ haatz ∥ snap ∥ farcaster.tv
│   ├── cast-page.tsx          # resolve (race) → CastData mapping → SSR / 404 / link fallback
│   ├── cast-route.test.ts     # bun:test; mock.module + exact-URL fetch mock
│   ├── clients.test.ts        # registry unit tests: templates, gating, signed rule, deeplinks
│   ├── cast-source.test.ts    # race unit tests: eligibility, box, miss/error, adapter mapping
│   └── shims/server-only.ts   # empty stub for Next.js marker package
└── src/                       # landing only (App.tsx)
```

## Routes

| Path | Handler | Response |
| --- | --- | --- |
| `/` | static asset `index.html` | landing SPA |
| `/api/` | Hono | `{ "name": "Cloudflare" }` |
| `/:username/:hash` (`0x…`) | Hono SSR | HTML: 200 cast card + OG/Twitter meta (title = `DisplayName (@handle)`, description = whitespace-collapsed cast text, 280 chars, image = first image embed else avatar; `summary_large_image` card only when the image is a cast embed image) + registry-driven client action row (see "Client registry" below); unsigned author (`/signed/{fid}` false): `requiresSigned` clients (farcaster) suppressed; 404 when Shim reports no such cast; 200 link-only when Shim is unreachable |
| `/:username/:hash?format=json` (or `Accept: application/json`) | Hono JSON | Strict-status agent variant — see "Agent JSON variant" below |
| other missing paths | worker 404 / no SPA fallback | `not_found_handling: none` |

**Multi-domain (dual-serve):** the same worker serves `forkcaster.xyz` and `warpcats.com` (custom-domain routes in `wrangler.jsonc`). All code is host-agnostic (per-request origin, same-origin fill script, host-only cookie), and every page canonicalizes to the primary: cast pages emit `<link rel="canonical">` + `og:url` from the `PRIMARY_ORIGIN` var (absent when unset — bare workers.dev keeps the pre-dual-serve output), the landing's canonical is baked into `index.html`. Race telemetry carries the request host as a blob for per-domain breakdown. Cookies/badges are per-domain by design.

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
- **Ban signal**: `signed: false` emits a short note field; unknown/failed check fails open silently (same fail-open semantics as the HTML action row).
- **Discoverability**: HTML pages emit `<link rel="alternate" type="application/json" href="?format=json">`.
- **Deferred**: UA-allowlist morphing (GPTBot, ClaudeBot, …) as a later progressive enhancement. Must stay an allowlist — Telegram/Discord/iMessage preview bots must keep receiving HTML + OG meta.
- No page-level caching today (Shim is the cache); if edge caching is ever added, the variant must join the cache key.

## Cast source race

Cast lookups race four providers (`worker/cast-source.ts`, rpc-racer pattern: fan out with per-provider abort + 5s cap, first **validated** win, losers aborted; a win must resolve the requested hash, else it's downgraded to an error).

**Sufficiency matrix** (measured Oct 2026) against the internal `ShimCast` contract (text, hash, unix-seconds ts, raw `{url}`/`{castId}` embeds, inline user data):

| Provider | Resolves (username, hash)? | Quotes ({castId}) | Verdict |
| --- | --- | --- | --- |
| shim | ✅ short + full | ✅ | complete — canonical, wins anytime |
| haatz (`haatz.quilibrium.com/v1`) | ⚠️ full hash only + fid via shim `/f/{username}` | ✅ | complete — full-hash requests |
| snap (`snap.farcaster.xyz:3381`, official gateway; 443 hangs) | ⚠️ same as haatz | ✅ | complete — full-hash requests |
| farcaster.tv | ✅ short (prefix-match) | ❌ **silently dropped** | partial — quote-blind |

**HTML path (700ms completeness box):** complete providers win anytime; a quote-blind farcaster.tv win is held until the box expires, then served as a **partial** page — the SWR tradeoff the OG meta is immune to: title/description/image never depend on quotes, so chat-bots' cached embed cards are always complete. The partiality only reaches live browsers, which self-heal: partial pages ship `QUOTE_FILL_SCRIPT`, which fetches `?embeds=quotes` (shim-resolved, quote-hydrated SSR fragment, `no-store`) and injects it — same silent-degradation contract as the live-stats script. **No server-side cache** is introduced: the last-used badge and signed suppression stay cache-key-free.

**JSON path:** shim-only (`boxMs: null`) — always complete, strict statuses (404 / 503 + Retry-After), the never-drop-quotes invariant holds unconditionally.

**Miss semantics:** shim's miss resolves `not-found` immediately (fast 404s); a miss from any complete provider (haatz/snap raw nodes' 400) is authoritative ⇒ 404 even if a partial landed; farcaster.tv 404 alone never produces a 404 (cast might exist). Everything-else-failed ⇒ link-only page (HTML) / 503 (JSON), fail-open as usual.

**Ban signal:** NOT raced — `/signed/{fid}` stays a shim dependency, orthogonal to cast content, time-boxed to the HTML box with the usual fail-open.

**Telemetry:** every resolve writes one Analytics Engine datapoint (`RACE_STATS` binding, non-blocking via `waitUntil`): index = winning provider (or outcome kind), doubles = total ms / box / partial flag, blob = per-provider `id:kind:ms` rows. Query via the CF GraphQL API when tuning the box; tests and callers without an executionCtx skip it.

Follow-ups: quote hydration could race haatz/snap (`/h/{fullHash}` vs `castById` — the castId embed carries the fid); a `?format=json` consumer willing to trade completeness for latency could opt into the race.

## Client registry (action row, last-used badge)

The cast page's "Open in …" pills are rendered from a data registry, `worker/clients.ts` — adding a client is a data change only.

- **Schema** (`ClientDefinition`): `id` (stable slug, cookie value), `title`, `logoUrl` (served from `public/logos/`), `web` (per-cast https template), `deeplink` (optional native mobile target — activates the click-time scheme attempt described below; absent ⇒ web-only), `requiresSigned` (suppressed only on a known `signed:false`; unknown fails open).
- **Templates** interpolate `{username}`, `{hash}` (route-form, short or full) and `{fullHash}` (Shim-resolved). The engine also supports an optional `{fid}` placeholder with a `missingVars` gate (a client needing it is skipped when the value is absent) — reserved for future entries. Values are percent-encoded at resolution and HTML-escaped at render.
- **Mobile deeplinks vs web targets**: one pill per client; the `href` is always the `web` URL. Universal links already open installed apps on mobile — verified per client: Farcaster's AASA claims all farcaster.xyz paths, Firefly's AASA explicitly claims `/post/*` (Android: `com.farcaster.mobile` and `io.dimension.firefly` confirmed via assetlinks.json). A structured `deeplink: { scheme, androidPackage? }` adds a native attempt for mobile only: the pill gains `data-scheme` + `data-intent` (the intent:// form carries `S.browser_fallback_url` = the web URL), and a conditional script intercepts clicks on coarse-pointer devices — Android uses the intent (Chrome-native fallback), everything else attempts the scheme and falls back to the web href if the app didn't open (~1.8s, visibility-aware). The script ships only when a rendered client actually has a `deeplink`. **Farcaster currently ships `farcaster://{username}/{fullHash}` — verified against the open-source app** ([farcasterxyz/client](https://github.com/farcasterxyz/client)): the app rewrites `farcaster://` to `https://farcaster.xyz/` and routes the rest as a web path, where cast URLs are `/{username}/{hash}` accepting full or short (≥8 hex) hashes; the legacy `/casts/:fname/:hash` route is gone. **Firefly ships no scheme** — none is documented anywhere; its web URL is already app-linked on both platforms.
- **Roster — all five clients have verified per-cast URLs**: farcaster (`/{username}/{hash}`), firefly, neynar, quilcast and vibeshift (full-hash based; neynar verified against `fc-clients-cast-action` `src/lib/deeplink.ts`; quilcast against backmeupplz/quilcast `server/index.mjs` — `/c/{fullHash}`, 40 hex with optional `0x`, live-checked; browser-only client, no native app; vibeshift `?view=cast&castHash={fullHash}&castFid={fid}` — needs the cast originator's fid, `{fid}`-gated so it's skipped on fid-less surfaces, owner-provided + user-verified).
- **Last-used cookie**: any click on a `data-client` pill writes `fc_client=<id>` (1 year, `SameSite=Lax`) via `CLIENT_SCRIPT`; on the next request the worker reads it and SSRs a small "last used" badge onto that client's pill. Unknown cookie values render nothing (registry whitelist). No cookie ⇒ no badge; no JS ⇒ links still work, the badge just doesn't move. Cookie-conditional HTML: if an edge cache is ever added, the badge must join the cache key.
- **Logos**: self-hosted in `public/logos/`, one static file per client — farcaster, quilcast and vibeshift as SVG, firefly and neynar as favicon PNGs. The pill's `<img>` renders `logoUrl` uniformly; no per-client code paths.

## Shim → CastData mapping

Providers return different shapes; `cast-source.ts` normalizes everything onto `ShimCast` (shim's raw Snapchain shape). `toCastData()` in `worker/cast-page.tsx` then adapts it for react-farcaster-embed:

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
| Provider race / cast data sources | `worker/cast-source.ts` |
| Client roster / action row data | `worker/clients.ts` |
| Routes | `worker/index.ts` |
| Aliases | `vite.config.ts`, `tsconfig.worker.json` paths |
| Landing | `src/App.tsx` |
| Deploy / CF | `wrangler.jsonc` |

## Status

Shim-first SSR data path raced across shim / farcaster.tv / haatz / snap (`cast-source.ts`); HTML serves quote-blind wins after a 700ms box and self-heals quotes client-side; JSON stays shim-complete and strict. Live stats still fetched client-side from farcaster.tv. Agent JSON variant (`?format=json`) shipped. Registry-driven action row shipped: last-used badge, Farcaster native deeplink (`farcaster://`, verified), four verified per-cast client URLs.
