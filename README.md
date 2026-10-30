# forkcaster — agent brief

> Audience: coding agents. Prefer facts over prose. Update this file when architecture or commands change.

## Intent

Micro-site that mirrors Farcaster cast URLs for sharing without the Farcaster app.

- Pattern: `/{username}/{castHash}` where `castHash` matches `0x[0-9a-fA-F]+` — short or full form
- Examples: `/zoo/0x895ecc74` and `/decent-artlu/0xbb54368f` → SSR cast card + links
- Data: raced across providers (`worker/cast-source.ts`, rpc-racer pattern) — see "Cast source race" below. **shim** (`https://shim.artlu.xyz/wc/{username}/{hash}`, owner-run Snapchain reader with a keep-warm cron) is the completeness anchor and the sole ban-signal dependency (`/signed/{fid}`); **farcaster.tv** is fast but quote-blind; raw nodes **haatz**/`snap.farcaster.xyz:3381` are complete and get the fid by racing shim `/f/{username}` against their own `/v1/userNameProofByName` (first numeric answer wins, loser aborted), plus a full hash requirement (`castById` 400s on short hashes). All upstream calls are capped at 5s.
- Missing cast: an authoritative miss from a complete provider (shim, haatz, snap) → 404 page; no provider resolved → link-only page (200). All upstream calls are capped at 5s (`AbortSignal.timeout`) — shim's cold sharded lookups can otherwise hang 15s+; timeout ⇒ unreachable. Strict statuses are the JSON variant's job (see below)
- Banned accounts: embeds render for everyone — but some clients hide unsigned authors. Since Oct 15, 2026 (Network School takeover), accounts must accept the "social smart contract" (Network Code); acceptance is an on-chain access NFT. Shim exposes it: `GET https://shim.artlu.xyz/signed/{fid}` → `{"signed":true|false}`. Unsigned authors: registry clients flagged `requiresSigned` (e.g. farcaster) are suppressed from the action row; the check fails open — unknown state suppresses nothing
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
| Live stats | client-side script → farcaster.tv | `LIVE_STATS_SCRIPT` in `cast-scripts.ts`; fills the SSR-stripped stats slot from the browser; fails silent (row absent); SSR data path stays Shim-only |
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
├── quilcast-router-shortcut.md # the iOS/macOS share-sheet router: mapping, build/sign, distribution
├── shortcuts/                 # generated .shortcut artifact (unsigned; `bun run shortcut:quilcast`)
├── worker/
│   ├── index.ts               # Hono app; export { app }; default { fetch }
│   ├── client-registry.ts     # client registry (verified templates; zero-dep, vendored-able)
│   ├── clients.ts             # fc_client cookie binding (last-used + auto-open prefs)
│   ├── shim.ts                # shim identity client (routes, ShimCast/ShimUser, /wc /h /f /u /user /casts-and-replies /signed, /refresh as the index warmer)
│   ├── cast-source.ts         # provider race: shim ∥ haatz ∥ snap ∥ farcaster.tv (+ the /~/{hash} hash-only rescue)
│   ├── cast-page.tsx          # resolve (race) → render orchestration: SSR / 404 / link fallback
│   ├── cast-data.ts           # pure Shim → embed-data mapping + embed helpers
│   ├── cast-actions.tsx       # action row + auto-open banner (server halves)
│   ├── cast-scripts.ts        # inline client scripts (TRACK/CLIENT/DEEPLINK/AUTO/LIVE_STATS/QUOTE_FILL)
│   ├── profile-page.tsx       # profile landings: resolve-once/render-twice, waypoint law
│   ├── warpcast.ts            # Warpcast channel API client (zod contract; /v1/channel — keyless, first-party)
│   ├── channel-page.tsx       # channel landings: resolve-once/render-twice, waypoint law
│   ├── shell.tsx              # shared page frame (head/meta/CSS/footer) — cast pages + profiles + /transparency
│   ├── cast-ref.ts            # MCP cast-ref: zod contract + shim-direct resolution
│   ├── mcp.ts                 # MCP SDK v2 server factory (get_cast_link) — only SDK import site
│   ├── cast-route.test.ts     # bun:test; mock.module + exact-URL fetch mock
│   ├── clients.test.ts        # registry unit tests: templates, gating, signed rule, deeplinks
│   ├── cast-source.test.ts    # race unit tests: eligibility, box, miss/error, abort, adapter mapping
│   ├── race-stats-store.ts    # lmdis snapshot read-through TTL cache (10min TTL / stale 24h / 2s cap)
│   ├── fid-race-store.ts      # mirror of the above for the "Author id races" snapshot (key fid-race)
│   ├── vendor/lmdis-sdk.ts    # vendored lmdis SDK (Upstash-shaped seam; get/set only)
│   └── shims/server-only.ts   # empty stub for Next.js marker package
├── scripts/
│   ├── race-stats.ts          # offline stats job: AE SQL → snapshot → lmdis (dotenvx env; --dry)
│   ├── race-stats-lib.ts      # pure query builders (fixture-tested)
│   ├── fid-race.ts            # offline fid-race job: FID_RACE AE SQL → snapshot → lmdis (mirror of race-stats.ts)
│   ├── fid-race-lib.ts        # pure fid-race query builders (fixture-tested)
│   ├── client-rank.ts         # offline rank job: CLICK_STATS AE SQL → weighted snapshot → lmdis
│   ├── client-rank-lib.ts     # pure query builders + weighting (fixture-tested)
│   ├── stats-alert.ts         # ntfy threshold alerter over the live lmdis snapshots (`stats:check`; --dry)
│   ├── quilcast-shortcut.ts   # generates the quilcast → share-sheet shortcut (mapping in quilcast-router-shortcut.md)
│   └── probe/                 # live-service probes (lmdis, AE SQL, shim timing)
└── src/                       # landing only (App.tsx)
```

## Routes

| Path | Handler | Response |
| --- | --- | --- |
| `/` | static asset `index.html` | landing SPA |
| `/api/` | Hono | agent-facing index: the JSON surfaces this worker serves (`cast`, `profile`, `channel`, `raceStats`, `transparency`) |
| `/prefs` | Hono | `POST` JSON `{ auto?: "on" \| "off", delay?: 0–5 }` (at least one field) → 204 + Set-Cookie (`fc_client`); delay omitted from the cookie at the default 5s. Auto-open preference write (server cookie — Safari ITP exemption) |
| `/t` | Hono | `POST` beacon (one per client selection): `{ c: slug, k: pill\|auto\|go-now, t?: web\|native, d?: coarse\|fine, f?: first\|switch\|repeat }` → 204 always (invalid = dropped, indistinguishable). Allow-listed against the active registry; one anonymous `CLICK_STATS` datapoint — no cast IDs, no IPs, no identifiers |
| `/transparency` | Hono | HTML facts page (what/data/tracking/domains — Domains carries registration expiry + RDAP confirm links — plus race-stats and client-rank tables filled server-side from lmdis snapshots, "stats as of" lines, and the registry-driven **Client coverage** matrix — clients × route kinds, straight from `targetFor`) or JSON twin via `?format=json`/Accept (`racingStats.status`/`clientRank.status`: live \| coming-soon; `clients` lists per-kind coverage); reserved exact path — cast URLs for a username named `transparency` still work |
| `/race-stats.json` | Hono | raw stats snapshot (same cached read as `/transparency`); 404 when absent; `cache-control: public, max-age=21600` |
| `/mcp` | Hono → MCP SDK v2 | MCP Streamable HTTP endpoint (POST JSON-RPC; public, no auth). One tool, `get_cast_link`: cast reference (longhash ∥ fid+shorthash ∥ username+shorthash) + target client → client URLs + author signed status; farcaster.xyz is the canonical surface. |
| `/:username/:hash` (`0x…`) | Hono SSR | HTML: 200 cast card + OG/Twitter meta (title = `DisplayName (@primary)` — identity law: the fname is the author handle everywhere on the page (og, canonical/og:url path, embed links, stats slot; ENS names are attestations, profile-only), legacy casts without fname degrade to the newest-proof username, description = whitespace-collapsed cast text, 280 chars, image = first image embed else avatar; `summary_large_image` card only when the image is a cast embed image; `og:site_name` = forkcaster) + registry-driven client action row (see "Client registry" below); unsigned author (`/signed/{fid}` false): `requiresSigned` clients (e.g. farcaster) suppressed, the embed's Show-on-Farcaster icon hidden (the library's `hideFarcasterLogo` — the farcaster.xyz page is dead for them, a local twin would self-link) and its stats slot flagged so client-built links go to the local waypoint; 404 when Shim reports no such cast; 200 link-only when Shim is unreachable |
| `/:username/:hash?format=json` (or `Accept: application/json`) | Hono JSON | Strict-status agent variant — see "Agent JSON variant" below |
| `/:username` | Hono SSR | Profile landing (waypoint law, strict dial: the identity card IS the page): the hydrated shim `/user/{fid}` entity (displayName/pfp/bio/fid — bio collapses with explicit http(s) URLs linkified (new tab, noopener; mentions/#channels stay inert), `primaryAddress` as truncated `<code>` **that is itself the Basescan link** (new window) + copy button) + a "Casts and replies" pill; **no cast list** — the list lives on `/:username/casts-and-replies`; the way out is the STATEFUL menu: registry-driven pills (rank-ordered, `data-client`, badge on the flat resolution — own `p:` cookie slug else the cast slug), auto-open banner/overlay from the same resolution (last-used cookie; `?noredirect=1` supported), telemetry beacons on clicks; unsigned accounts (`/signed/{fid}` false, null fails open) get farcaster suppressed (`requiresSigned` on the kind target) + the read-only notice — Quilcast (/u/ route) + Quorum (source-verified profile deep link) remain via the registry; JSON twin stays cookie-free; OG meta (`og:type` profile, `twitter:card` summary, image = pfp); single segment registered LAST — reserved exact routes and the two-segment cast route win by registration order; trailing-slash forms (`/{username}/`, `/{username}/casts-and-replies/`) 301 to the canonical non-slash URLs (query preserved); charset gate + bot-path denylist 404 without upstream calls; 404 on shim `/f` miss (or sparse `/user` shape), 503 + Retry-After when shim is unreachable; the HTML path **skips the timeline call entirely**; **echo-the-valid-input**: first-party links (the pill) carry the gate-validated route input — shim resolves any resolvable alias (fname/ENS/basename) to the same fid, and `/user/{fid}` answers the NEWEST username proof, which can differ from what was typed — while display, OG/canonical, and external client targets carry the PRIMARY handle (**identity law**: the fname — the account's first name — is primary; ENS names are attestations, rendered bold-primary + muted parens on the card `@arfonzo (arfonzo.eth, …)`, capped at 3, and listed uncapped in the JSON; legacy entities without fname degrade to the newest-proof username) |
| `/:username?format=json` (or `Accept: application/json`) | Hono JSON | Strict-status profile twin: `{ username, fid, attestations?, displayName?, bio?, pfp?, primaryAddress?, casts?: [{ hash, text?, timestamp, url }], note? }` — `username` is the PRIMARY handle (the fname; identity law), `attestations` lists every verified ENS name uncapped when known — 404 / 503 + Retry-After like the cast JSON; listed in `/api/` |
| `/:username/casts-and-replies` | Hono SSR | The ONE list surface (farcaster.xyz URL-shape mirror): every cast rendered **in full** — exactly the individual cast page's pipeline (react-farcaster-embed SSR, unfurl-enriched URL embeds ≤3/cast, shim-hydrated quotes ≤3/cast via the same `fetchQuote` (`/h` with the `/u`→`/wc` fallback), hardened blank targets, per-card live-stats slot; `LIVE_STATS_SCRIPT` fills every slot on the page). Author attached from the hydrated entity (shim timeline rows are author-implied); minimal `@handle` head linking the profile (the link echoes the validated input, the visible handle carries the primary — identity law), plus the stateful FEED menu + auto-open (farcaster + quorum are the seeded feed targets — quorum's pill is coarse-only and scheme-only, its list shows top-level casts; suppressed to an empty row + read-only notice when unsigned; every card's farcaster.xyz cast anchors (Show-on-Farcaster icon + client-built stats links) retarget to the local waypoint via the shared `renderEmbedCard` — signed or not, the waypoint always resolves (profile anchors and author-typed farcaster.xyz links stay)); **OG preview identical to the profile's** (same card visual, deeper page — canonical/og:url stay on this URL); **no JSON twin** (alternate link omitted). Shim `/f` verdict ⇒ 404; unreachable ⇒ 503 + Retry-After; timeline failure fails soft, ok-empty ⇒ "No casts yet." |
| `/~/conversations/:hash` (`0x…`) | Hono redirect | Warpcast legacy thread-shape alias — the purest waypoint, **no surface**: resolve via shim `/h/{hash}` (fid fallback via `/u` when the cast is username-less) and **302** (not 301 — mapping stays cache-free) to the canonical `/{username}/{fullHash}` cast waypoint — the PRIMARY handle (fname first; shim /u answers it too), relative Location (dual-serve hosts stay self-contained); a bare shim miss is no verdict — the index is partial (kept-warm fids only) — so it falls to the farcaster.tv hash-only rescue (`/~/0x…`, resolves the live chain; raw nodes can't — castById demands fid + full hash), which also fires a fire-and-forget shim `/refresh` warm so the next visitor hits `/h`; 404 only on an authoritative rescue miss / unresolvable username, 503 + Retry-After when the surviving source is unreachable; short hashes miss at shim (measured) and 404 honestly |
| `/~/profiles/:id` | Hono redirect | farcaster.xyz's fid-profile URL shape (it renders the profile in place; the `{username}` shape answers there too) — forkcaster keeps ONE canonical surface per account, so it's a waypoint, not a second page: all-digits ids resolve via shim `/u/{fid}` (profile-family discipline — 8s window, one retry; non-2xx/throw ⇒ 503 + Retry-After, HTTP-200 miss ⇒ 404) then **302** (never 301 — mapping stays cache-free) with a relative Location to `/{username}` (the PRIMARY handle — shim /u is fname-first); the username shape canonicalizes with zero fetches (charset gate, lowercased); ids past `Number.MAX_SAFE_INTEGER` and charset garbage 404 with zero fetches; trailing-slash form 301s to the non-slash alias (query preserved) |
| `/~/channel/:id` | Hono SSR | Channel landing (waypoint law, identity-only): the identity card from the official Farcaster channel API (`api.farcaster.xyz/v1/channel` — the host formerly at api.warpcast.com, byte-identical; keyless, ~150ms, zod-wrapped in `worker/warpcast.ts`) — header banner/icon, name + `/{id}` handle, description (escaped plain text, no mention resolution), created date + lead-fid facts; engagement counts (follower/member) are withheld from HTML and live in the JSON twin; way out = a hand-verified pill trio (per-target provenance in the client registry) — **Farcaster** (`farcaster://~/channel/{id}` native attempt, source-verified against the open-source app; the `~/` is load-bearing), **Firefly** (`firefly.social/channel/farcaster/{id}`, web-only, owner-confirmed route) and a **coarse-pointer-only Quorum** pill (`quorummobile://feed?channelKey={id}`, source-verified; its web build has no channel page, so desktop never sees it) + the channel's own external link only when http(s); the row rides the cast page's stateless DEEPLINK_SCRIPT for click-time native attempts — **no fc_client memory, no click telemetry** (owner call: don't remember or track); SSR is byte-identical for every device (CSS pointer-class picks, no UA sniffing). OG `og:type` website, `twitter:card` summary, image = channel icon. The `/~/channel/{id}` form — farcaster.xyz's own channel URL shape, which canonical + og:url carry — is the **only shape served**: the bare `/channel/{id}` shape 404s with zero fetches (a plain id would shadow a user literally named `channel`, while `/channel/0x…` hashes fall through to the cast route — the tradeoff `/transparency` still carries). Registered BEFORE the two-segment cast route so hash-shaped ids route here; charset gate lowercases and 404s garbage with zero upstream fetches. 404 on the API's HTTP 400 miss; 503 + Retry-After on anything else (no fail-open source). **One stateless script (the trio's DEEPLINK_SCRIPT), zero cookies, zero telemetry.** The recent-casts skeleton is deferred: shim's channel feed measured 8–15s+ per call |
| `/~/channel/:id?format=json` (or `Accept: application/json`) | Hono JSON | Strict-status channel twin: `{ id, name?, description?, image?, headerImage?, createdAt?, parentUrl?, leadFid?, moderatorFids?, followerCount?, memberCount?, publicCasting?, pinnedCastHash?, externalLink?, farcaster }` — 404 / 503 + Retry-After like the profile JSON; carries the engagement counts and routing data (parent key, pinned cast) the HTML withholds; listed in `/api/` |
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
- **Availability-gated payload** — a field appears only when its data exists: author, ISO 8601 timestamp, text, image embed URLs, URL embeds (unfurl title appended when unfurl succeeded, bare URL otherwise), quote embeds, canonical farcaster.xyz + Firefly links. The author `username`, the farcaster link, and hydrated-quote pointers carry the PRIMARY handle (identity law: fname first; ENS names are attestations).
- **Quotes are pointers, never dropped**: hydrated quote → forkcaster URL (requires the username from the hydrated cast — the quoted author's PRIMARY handle under the identity law); hydration failure → Firefly full-hash URL (quote embeds carry `{fid, hash}`, no username). HTML's rendering constraints (unguarded `author.pfp.url`) don't apply to JSON — failed hydration degrades to a URL the agent can fetch.
- **Ban signal**: `signed: false` emits a short note field; unknown/failed check fails open silently (same fail-open semantics as the HTML action row).
- **Discoverability**: HTML pages emit `<link rel="alternate" type="application/json" href="?format=json">`.
- **Deferred**: UA-allowlist morphing (GPTBot, ClaudeBot, …) as a later progressive enhancement. Must stay an allowlist — Telegram/Discord/iMessage preview bots must keep receiving HTML + OG meta.
- No page-level caching today (Shim is the cache); if edge caching is ever added, the variant must join the cache key.

## MCP

`https://forkcaster.xyz/mcp` (also `warpcats.com/mcp`) — MCP **Streamable HTTP** endpoint, public, no auth, stateless. One tool: **`get_cast_link`** — resolve a Farcaster cast (full 40-hex hash, or fid/username + short hash) into deep-link URLs for any supported client, with the author's signed-contract status. Links-only clients (`requiresExternalLinks`) are gated: they answer `client_ineligible` and drop from `all` when the resolved cast carries no external URL embed. Wiring: `worker/mcp.ts` (SDK) + `worker/cast-ref.ts` (zod contract, shim-direct resolution).

Registry listing: `server.json` (repo root, official registry schema 2025-12-11, name `xyz.forkcaster/mcp`). To publish, install the official publisher CLI — a GitHub-release binary. ⚠️ **do NOT `bunx`/`npx` the npm package `mcp-publisher`** — it's an unrelated browser-automation project that collides with the name:

```sh
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_linux_amd64.tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/
```

One-time domain verification: generate an ed25519 keypair (`openssl genpkey -algorithm Ed25519 -out key.pem`), add the apex TXT record it prints (`v=MCPv1; k=ed25519; p=<public key>`), then:

```sh
mcp-publisher login dns forkcaster.xyz --private-key <hex>   # signs the challenge → xyz.forkcaster namespace
mcp-publisher publish                                        # submits server.json to registry.modelcontextprotocol.io
```

`key.pem` is the publishing credential — keep it safe, never commit it.

## Cast source race

Cast lookups race four providers (`worker/cast-source.ts`, rpc-racer pattern: fan out with per-provider abort + 5s cap, first **validated** win, losers aborted; a win must resolve the requested hash, else it's downgraded to an error). A fifth complete leg — **shim-potato** (`shim-potato.artlu.xyz`, self-hosted) — joins the race when the `SHIM_POTATO_BASE` var is set: same canonical shape, but its misses are **not** authoritative (it can never 404 a cast the race would otherwise resolve), and the JSON twin stays shim-only either way.

**Shim-potato races every shim read** (`worker/shim.ts`, `raceShimProbe`): the profile family (`/f`, `/user`, `/signed`, timeline), the quote hydrator's `/h`→`/u`→`/wc` chain, both aliases, the signed check on cast pages, and the MCP tool each race cloud against the canary when the var is set. The contract is the canary's, generalized: the **first affirmative answer wins outright** (a fast leg rescues a slow one); a cloud **consulted miss** (HTTP 200, no data) is terminal the moment it lands — the potato can never overturn or delay a verdict, so true misses 404 exactly as fast as before; a cloud **error** (non-2xx/timeout) defers to a still-pending potato leg before surfacing; potato misses/errors are never authoritative. Without the var every wrapper is a pass-through (exactly one fetch, byte-identical behavior). The `/refresh` index warm covers both hosts.

**Sufficiency matrix** (measured Oct 2026) against the internal `ShimCast` contract (text, hash, unix-seconds ts, raw `{url}`/`{castId}` embeds, inline user data):

| Provider | Resolves (username, hash)? | Quotes ({castId}) | Verdict |
| --- | --- | --- | --- |
| shim | ✅ short + full | ✅ | complete — canonical, wins anytime |
| haatz (`haatz.quilibrium.com/v1`) | ⚠️ full hash only + fid via shim `/f/{username}` | ✅ | complete — full-hash requests |
| snap (`snap.farcaster.xyz:3381`, official gateway; 443 hangs) | ⚠️ same as haatz | ✅ | complete — full-hash requests |
| farcaster.tv | ✅ short (prefix-match) | ❌ **silently dropped** | partial — quote-blind |

**HTML path (700ms completeness box):** complete providers win anytime; a quote-blind farcaster.tv win is held until the box expires, then served as a **partial** page — the SWR tradeoff the OG meta is immune to: title/description/image never depend on quotes, so chat-bots' cached embed cards are always complete. The partiality only reaches live browsers, which self-heal: partial pages ship `QUOTE_FILL_SCRIPT`, which fetches `?embeds=quotes` (shim-resolved, quote-hydrated SSR fragment, `no-store`) and injects it — same silent-degradation contract as the live-stats script. **No server-side cache**: the last-used badge and signed suppression stay cache-key-free.

**JSON path:** shim-only (`boxMs: null`) — always complete, strict statuses (404 / 503 + Retry-After), the never-drop-quotes invariant holds unconditionally.

**Miss semantics:** shim's miss resolves `not-found` immediately (fast 404s); a miss from any complete provider (haatz/snap raw nodes' 400) is authoritative ⇒ 404 even if a partial landed; farcaster.tv 404 alone never produces a 404 (cast might exist). Everything-else-failed ⇒ link-only page (HTML) / 503 (JSON), fail-open as usual.

**Ban signal:** NOT raced — `/signed/{fid}` stays a shim dependency, orthogonal to cast content, time-boxed to the HTML box with the usual fail-open.

**Telemetry:** every resolve writes one Analytics Engine datapoint (`RACE_STATS` binding, non-blocking via `waitUntil`): index = winning provider (or outcome kind), doubles = total ms / box / partial flag, blob = per-provider `id:kind:ms` rows (race-abort losers record `abort`, not `error`). Raw-node legs that settle their identity race also write one `FID_RACE` datapoint each (index = winning source `shim`/`node`, blob = leg + host, double = ms). Query via the AE SQL API when tuning the box (`scripts/probe/`, `scripts/race-stats.ts`); tests and callers without an executionCtx skip it.

Follow-ups: quote hydration could race haatz/snap (`/h/{fullHash}` vs `castById`) for extra completeness — the shim-internal `/u/{fid}` → `/wc` fallback (Oct 2026) already rescues casts the hash-only `/h` index misses; a `?format=json` consumer willing to trade completeness for latency could opt into the race.

## Observed full Hypersnap nodes (documentation only — not wired into the race roster)

Two additional public Hypersnap nodes were observed live via their self-reported `/v1/info` endpoint (the same public info endpoint haatz exposes). They are full Hypersnap nodes (Rust Farcaster node, HTTP on `:3381`) operated by independent parties — **not part of `cast-source.ts`'s race roster** (shim / farcaster.tv / haatz / snap), and no code references them. Listed here for operator visibility only.

| Node | Version | Messages | FIDs | Approx size | Shards | Peer ID |
| --- | --- | --- | --- | --- | --- | --- |
| `https://hypersnap.rainonmeproductions.com` | 0.15.0 | 914,368,020 | 3,356,878 | ~812.9 GB | 3 (0,1,2) | `12D3KooWMzgU6PgzsJ4…` |
| `https://hypersnap.castrater.xyz` | 0.16.0 | 914,368,025 | 3,356,878 | ~797.0 GB | 3 (0,1,2) | `12D3KooWRjMdSgmsuh1n…` |

For comparison, the wired nodes report: haatz `0.16.0` / 914,368,020 msgs / ~797.6 GB / peer `12D3KooWMYfkXiNcn9L…`; snap `0.16.0` / 914,368,024 msgs / ~551.3 GB / peer `12D3KooWH527dqZTziqz…`. Message and FID counts match across all nodes (same network); `approxSize` differs per-node (local RocksDB storage). Both answer `GET /v1/info` with `dbStats` (`numMessages`, `numFidRegistrations`, `approxSize`), `numShards`, `shardInfos` (shardId, maxHeight, numMessages, blockDelay), `version`, and `peer_id`. No race integration, no cache, no telemetry wiring — purely informational.

## Race stats (/transparency)

The racing-stats table is filled **offline** — the render path stays cache-free and stats-free. `bun run stats` (env per `.env.example`) queries Analytics Engine through the **SQL API** — sample-weighted (`sum(_sample_interval)`, `quantileExactWeighted`; never raw `count()`) — assembles a versioned snapshot (`v: 1`; wins/requests/p50/p95/errorRate per provider + outcome counts) and publishes it as one lmdis key (`race-stats` on `lmdis.artlu.xyz`, the owner-run Redis-shaped KV) through the vendored Upstash-shaped SDK. Overwrite-only-on-success; `--dry` previews.

The transparency route reads the snapshot through a per-isolate TTL cache (`worker/race-stats-store.ts`: 10 min TTL, 60s failure backoff, last-good served ≤24h, 2s read cap) and fills the table, the "stats as of" line, and the JSON twin's `racingStats` — absent/unreachable snapshot ⇒ "coming soon" dashes, silently. `/race-stats.json` serves the raw snapshot (404 when absent). Both responses are **edge-cached** (Cache API: the transparency page `s-maxage=60`, the raw snapshot `s-maxage=300`) — the reads and the render run at most once per colo per TTL window; cached hits trigger zero lmdis reads, and the three store reads fire as one parallel fan-out (concurrent GETs don't queue server-side). `bun run stats:check` reads the live snapshots directly and pushes to ntfy.sh when thresholds breach (provider p95/errorRate, snapshot staleness as the pipeline's dead-man's-switch, lmdis unreachable; `--dry` previews; env in `.env.example`). Alerting layout: Uptime Kuma (owner-hosted, ntfy) owns uptime probes + a stats-pipeline push monitor; `stats:check` owns data-quality thresholds; the self-hosted VPS runs a box-local `potato-watch` cron (disk/load/memory → ntfy). Synthetic monitors never target cast URLs — each probe would trigger a full provider race and pollute the published stats. SQL dialect + store behavior are live-verified by `scripts/probe/` (the AE dialect has no `CONCAT` and only `toUInt32`/`toUInt8` conversions; SQL errors come back as plain-text 422s; the SQL API rejects Account Owned Tokens — use a User token with Account Analytics:Read).

## Fid races (/transparency, parallel to race stats)

The raw-node legs race shim `/f/{username}` against the node's own `/v1/userNameProofByName` for the author fid (see "Cast source race"). Each settled race writes one `FID_RACE` Analytics Engine datapoint (index = the WINNING source — `shim` or the leg's own id `haatz`/`snap`, blob = leg id + host, double = the winner's ms), and `bun run stats:fid` (same env discipline as `stats`) aggregates it into a second lmdis key (`fid-race`, overwrite-only-on-success, `--dry` previews). Nodes are tracked independently — a node's win is attributed to that node, never merged into a bucket. `/transparency` reads it through `worker/fid-race-store.ts` — a line-for-line mirror of the race store (same TTL/backoff/stale contract) — and renders the **Author id races** item (wins/p50/p95 per source, raw ids as row labels + raced-lookups line) plus the JSON twin's `fidRace` block (`status`: live \| coming-soon). Declared as a third entry in `tracking.counters` (`fidRace`); no cast IDs, no identifiers.

**Abort telemetry:** race-cut losers are recorded as `provider:abort:<ms>` (not `error`) so public errorRate stays honest — the 700ms box cuts slow completes by design; the 5s hard-timeout still counts as an error. `raceCast` drains pending settles after abort (bounded 25ms) so timing rows never escape incomplete.

## Client rank (click-through stats, /transparency)

Which client people actually open casts with — measured, weighted, published, and used to order the pill row. Pipeline mirrors race stats exactly:

- **Capture** (`POST /t`, allow-listed in `worker/track.ts`): one anonymous datapoint per client selection — slug, kind (`pill` explicit click / `auto` timer-fired redirect / `go-now` explicit open), transport (`native` when the click-time path attempted the app), coarse device class (client-side `matchMedia`, keeping the no-UA-sniffing invariant), host. The `first`/`switch`/`repeat` flag is computed client-side from the visitor's own cookie **before** the click rewrites it — the server never sees it. Invalid bodies are indistinguishable from valid ones (204 always). **Never captured:** which cast, usernames, IPs, UA strings, identifiers — the negative list is the privacy design and `/transparency` declares it. Beacons ride `TRACK_SCRIPT` (`window.__fk`, sendBeacon → keepalive-fetch fallback) called from `CLIENT_SCRIPT` (pills) and `AUTO_SCRIPT` (auto / go-now, incl. the countdown link, which also cancels the pending timer so a manual native attempt isn't re-redirected).
- **Weighting** (defuses the auto-open feedback loop — auto events echo an earlier choice): first ×1.0, switch ×1.0, go-now ×0.8, repeat ×0.3, auto ×0.1. Score over a trailing 7d window (`bun run stats:rank` → lmdis key `client-rank`, overwrite-only-on-success, same env as `stats`). `total < 100` ⇒ `warmingUp` — counts shown, shares withheld.
- **Consumption**: `worker/client-rank-store.ts` (same TTL/backoff/stale contract as the race store). `/transparency` reads full-cap and renders the Client choices table + JSON twin `clientRank` (weights are part of the published contract). The cast render path reads through `getRankSnapshotSoon(env, 400)` — a cold lmdis refresh never stalls a page; timeout ⇒ registry order. Pills are **reordered, never hidden** (every offered client renders; registry order is the tiebreak; the registry kill switch outranks popularity).
- **Disclosure**: the `/transparency` Tracking section declares both counters (`tracking.counters` is `{ pageLoad, clientChoice }` — the declared agent-facing shape), and the auto-open flow is covered by the click event.

## Client registry (action row, last-used badge)

The cast page's "Open in …" pills are rendered from a data registry, `worker/client-registry.ts` — adding a verified client is a data change only. Adding one is a guided workflow: the **`add-client` skill** at `.claude/skills/add-client/SKILL.md` (verify the per-cast URL against open-source code/docs plus a live check, write the entry with its provenance comment, add the self-hosted logo, update the roster-guard tests, run the checks, PR per `CONTRIBUTING.md`).

- **Schema** (`ClientDefinition`): `id` (stable slug, cookie value), `title`, `logoUrl` (served from `public/logos/`), `web` (per-cast https template), `deeplink` (optional native mobile target — activates the click-time scheme attempt described below; absent ⇒ web-only), `requiresSigned` (suppressed only on a known `signed:false`; unknown fails open), `requiresExternalLinks` (cast-eligibility gate for links-only clients: offered only when the cast carries at least one external URL embed — fail-closed, unknown hides; the shared `blockedByLinkGate` predicate gates the MCP tool identically, answering `client_ineligible` and omitting the client from `all`).
- **Templates** interpolate `{username}`, `{hash}` (route-form, short or full), `{fullHash}` (Shim-resolved) and `{fullHashRaw}` (bare lowercase hex, no `0x` — derived from `{fullHash}` for apps that key internally on raw hex). The engine also supports an optional `{fid}` placeholder with a `missingVars` gate (a client needing it is skipped when the value is absent). Values are percent-encoded at resolution and HTML-escaped at render.
- **Mobile deeplinks vs web targets**: one pill per client; the `href` is always the `web` URL. Universal links already open installed apps on mobile — which clients have verified claims (AASA paths, assetlinks.json package ids), and how each was confirmed, is recorded per entry in the registry comments. A structured `deeplink: { scheme, androidPackage? }` adds a native attempt for mobile only: the pill gains `data-scheme` + `data-intent` (the intent:// form carries `S.browser_fallback_url` = the web URL), and a conditional script intercepts clicks on coarse-pointer devices — Android uses the intent (Chrome-native fallback), everything else attempts the scheme and falls back to the web href if the app didn't open (~1.8s, visibility-aware). The auto-open redirect mirrors the attempt: the banner carries server-resolved `data-auto-scheme`/`data-auto-intent`, phones attempt the app with a 2.5s visibility fallback (no user gesture anchors a timer-driven navigation, and Quorum cold-starts past 1.8s), the countdown's client-rendered anchor carries `data-scheme` so manual taps go through the click-time script, and desktop or web-only clients keep the plain redirect. The script ships only when a rendered client actually has a `deeplink`. Which clients ship a scheme — and how each scheme was verified — lives in the per-entry registry comments.
- **Roster** — deliberately not enumerated in docs: `CLIENTS` in `worker/client-registry.ts` is the source of truth and the one place the roster is listed; each entry's comment records its verification evidence (URL-format provenance, scheme/manifest checks, live verification, per-client limitations). Every roster entry carries a **verified per-cast target**: a per-cast `web` template, or — when the client has no web cast route — a homepage-stub `web` href whose native scheme is the only per-cast target (a scheme-only entry). **Entries arrive verified or not at all**: an unverified format is never added, not even as a stub.
- **Last-used cookie**: any click on a `data-client` pill writes `fc_client=<id>` (1 year, `SameSite=Lax`) via `CLIENT_SCRIPT`; on the next request the worker reads it and SSRs a small "last used" badge onto that client's pill. Unknown cookie values render nothing (registry whitelist). No cookie ⇒ no badge; no JS ⇒ links still work, the badge just doesn't move. Cookie-conditional HTML: if an edge cache is ever added, the badge must join the cache key.
- **Logos**: self-hosted in `public/logos/`, one small static file per client (SVG, or PNG downscaled to ≤64px). Self-hosting is deliberate — **no hotlinking**: a client-CDN logo would leak every visitor's IP to that client's servers on every page view (a tracking surface the `/transparency` declarations would have to carry), and hotlinks break anyway (referrer checks, 403s) — so there is no remote-fallback path either. The pill's `<img>` renders `logoUrl` uniformly; no per-client code paths.

## Shim → CastData mapping

Providers return different shapes; `cast-source.ts` normalizes everything onto `ShimCast` (shim's raw Snapchain shape). `toCastData()` in `worker/cast-data.ts` then adapts it for react-farcaster-embed:

- `timestamp` is unix **seconds** → multiplied by 1000 (the embed does `new Date(ts)`)
- `embeds` are untyped `{url}` / `{castId}` items → bucketed into `images` / `urls` / `casts`; image heuristic = `imagedelivery.net` host or image extension. **Quotes are hydrated** through Shim `GET /h/{fullHash}` — with a `/u/{fid}` → username → `/wc/{username}/{hash}` fallback when the hash-only `/h` index misses a live cast (measured Oct 2026) — at depth 1 and mapped like any cast; hydration failure (e.g. pruned casts) drops the quote. URL embeds render as link cards via `openGraph` (see unfurl above)
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
| Shim mapping / resolve / SSR renderers | `worker/cast-page.tsx` (+ `cast-data.ts`, `cast-actions.tsx`, `cast-scripts.ts`, `shell.tsx`) |
| Provider race / cast data sources | `worker/cast-source.ts` |
| Client roster / action row data | `worker/client-registry.ts` |
| Routes | `worker/index.ts` |
| Aliases | `vite.config.ts`, `tsconfig.worker.json` paths |
| Landing | `src/App.tsx` |
| Deploy / CF | `wrangler.jsonc` |

## Status

Shim-first SSR data path raced across shim / farcaster.tv / haatz / snap (`cast-source.ts`); HTML serves quote-blind wins after a 700ms box and self-heals quotes client-side; JSON stays shim-complete and strict. Live stats still fetched client-side from farcaster.tv. Agent JSON variant (`?format=json`) shipped. Registry-driven action row shipped: last-used badge, Farcaster native deeplink (`farcaster://`, verified), a verified per-cast target for every roster client.
