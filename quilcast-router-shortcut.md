# quilcast → : a share-sheet router (iOS + macOS)

An Apple Shortcut that sits in the share sheet. Share any quilcast link to it,
pick a target, it opens the same cast/profile there. Works on iOS and macOS
(shortcuts sync over iCloud); no Xcode involved.

## The mapping (all routes verified Oct 2026)

Quilcast gives us exactly two link shapes:

- Cast: `https://quilcast.com/c/0x<40hex>` (0x optional — the regex strips it)
- Profile: `https://quilcast.com/u/<username>`

Resolution is **lazy** (Phase 3): forkcaster, farcaster and firefly ride the
bare forms below — zero network, zero privacy prompts, ever. Quorum is the
only target that needs an identity (profiles need a fid, casts want the
username), so only a Quorum tap triggers one resolve call against
forkcaster.xyz's public surface.

| Target | Cast (identity resolved) | Cast (fallback, hash only) | Profile | Verified |
|---|---|---|---|---|
| **forkcaster** (default) | `https://forkcaster.xyz/{username}/<0xhash>` | `https://forkcaster.xyz/~/conversations/<0xhash>` → 302 to the canonical page | `https://forkcaster.xyz/<username>` | canonical + alias live-checked: 302 → `/zoo/0x895ecc…` |
| **farcaster** | `https://farcaster.xyz/{username}/<0xhash>` | `https://farcaster.xyz/~/conversations/<0xhash>` (legacy Warpcast route, client-routed) | `https://farcaster.xyz/<username>` | both live-checked 200; on iOS the AASA should universal-link into the app |
| **firefly** | `https://firefly.social/post/farcaster/<0xhash>` (username not needed) | same | `https://firefly.social/profile/farcaster/<username>` | registry-verified Oct 2026 (AASA claims the cast route → native app opens; curl gets Vercel's bot checkpoint, that's documented) |
| **quorum** (phones) | `quorummobile://feed?castHashPrefix=<0xhash>&username=<username>` | `quorummobile://feed?castHashPrefix=<0xhash>` | `quorummobile://feed?profileFid=<fid>&profileUsername=<username>` | scheme + both param shapes verified in the registry (profile: `initialProfile` → SocialFeedModal; fid required) |

Notes:

- `0x` is **required** by forkcaster's `/~/conversations/` alias (non-0x shapes
  never match the route) — the shortcut always normalizes to `0x` + 40 hex, so
  both quilcast forms work.
- farcaster's `farcaster://` scheme rewrites to farcaster.xyz paths
  (registry-verified mechanism), so if you'd rather force the app, swap the
  farcaster cast URL to `farcaster://<username>/<0xhash>` — with the
  caveat that iOS does nothing when the app isn't installed.
- Quorum is phones-only (the desktop build's Farcaster surface is a literal
  "Coming soon") — keep it low in the menu on a Mac.

## Build it

The action graph is generated, not built in the editor:

```sh
bun run shortcut:quilcast
```

That writes `shortcuts/quilcast-router.shortcut`. Shortcuts refuses an unsigned
file, and signing only exists on a Mac that is signed into iCloud:

```sh
shortcuts sign --mode anyone \
  --input shortcuts/quilcast-router.shortcut \
  --output "$HOME/Desktop/quilcast →.shortcut"
open "$HOME/Desktop/quilcast →.shortcut"
```

The name comes from the file you open. Add Shortcut. With iCloud sync on, the
same shortcut appears on the other device.

- **iOS**: it shows in the share sheet (it accepts URLs). Quilcast's share
  button → `quilcast →` → menu → target → opens.
- **macOS**: System Settings → Extensions (under Privacy & Security or
  General, depending on version) → **Share Menu** → tick `quilcast →`.
  Safari's share button then lists it.

What the file does: Get URLs from the share, and use that text when it
contains `quilcast.com` (otherwise the raw share text). `/c/` sets `Hash`
(`0x` + 40 hex) and kind `cast`; `/u/<name>` sets `Username` and kind
`profile`; anything else notifies and stops. A leading word
`forkcaster|farcaster|firefly|quorum` on the raw input skips the menu. Only
Quorum calls the network: a cast POSTs `tools/call` to `forkcaster.xyz/mcp`
and reads `result.structuredContent.resolved` (the SSE `data:` line — `resolved`
is not at the top), a profile GETs `/{username}?format=json` and reads `fid`.
Opens follow the mapping table. A Quorum profile with no fid alerts and opens
Forkcaster.

The two Get Contents of URL actions are flagged continue-on-error. If a Mac
import drops that flag, turn it on for those two actions so a failed lookup
still opens the hash-only Quorum URL (or Forkcaster, for a profile).

### Passing the target programmatically

The input's leading word overrides the menu:

```sh
shortcuts run "quilcast →" "firefly https://quilcast.com/c/0x895ecc7415208bfb6105a8cb675f391f19cb9e2c"
```

- macOS: as-is from Terminal/AppleScript/launchd.
- iOS: from another shortcut (Run Shortcut with input), Focus/automation, or
  back-tap. No prefix word → the menu shows.

## Shipping it to everyone

The build above already IS the everyone build: the lazy resolver rides
forkcaster.xyz's public, stable surface (MCP + profile JSON twin) — no shim
dependency, and no network at all for the three non-Quorum targets. What
remains is distribution through Apple's only sanctioned channel:

1. **Share → iCloud link.** Shortcuts app → open `quilcast →` → share →
   **Copy iCloud Link**. Apple signs the shortcut at upload time; that link is
   the only way anyone else can install it (sideloading a `.shortcut` file
   fails — unsigned imports are refused). The link is a claim ticket: whoever
   opens it gets the signed copy and an **Add Shortcut** button.
2. **Publish the link** — README, blog post, or a line on forkcaster.xyz.
   Anyone on iOS 15+/macOS 12+ can add it; no account, no dev tools.

What each new user experiences: add via the link → the shortcut appears in
their share sheet forever → forkcaster/farcaster/firefly taps run with **no
prompts at all**; the first Quorum tap pops one privacy prompt
("`quilcast →` wants to access forkcaster.xyz" — tap Allow; native HTTP, no
CORS involved), then never again.

Gotchas to know before shipping:

- **Updates are frozen snapshots.** Each iCloud link serves exactly the
  version you shared. Change the shortcut → share a NEW link → publish the
  new URL (old links keep installing the old version).
- **Scale.** Only Quorum taps touch the network: one = one resolve call
  (MCP POST cast-side, one JSON GET profile-side), bounded by the worker's
  5s caps. Trivial at friend/community scale; if it ever hits a wide
  audience, add caching or rate-limiting to `/mcp` first — it's deliberately
  cache-free today.
- **Gallery distribution** (Apple-curated) exists but needs submission and
  review — only worth it if this becomes a product. The upgrade path beyond
  shortcuts is a Safari Web Extension on the App Store ($99/yr, review) —
  same redirect, zero per-share taps, real friction to ship.

## Caveats

- Only Quorum taps touch the network (lazy resolve). Underneath, the MCP is
  shim-direct and the shim is measured bursty (occasional >10s hangs,
  ~1-in-10) — the shortcut has no retry; a failed resolve just degrades to
  the fallback forms. That's the right trade for a share-sheet tap; add a
  second attempt if it annoys you.
- `farcaster.xyz/~/conversations/` serves the generic SPA shell to non-bot
  fetchers and routes client-side — fine for humans tapping through, no SSR
  meta. The resolved canonical form `farcaster.xyz/{username}/{hash}` is the
  registry-verified shape; the shortcut keeps the alias to stay zero-network
  for farcaster taps.
- `all` from the MCP is web-hrefs only; Quorum's native scheme is built
  from `resolved.username` / `resolved.fid` in `scripts/quilcast-shortcut.ts`.
- If a target's format ever changes, this file and that script are the two
  places to touch.
