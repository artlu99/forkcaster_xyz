---
name: add-client
description: Add a new Farcaster client app to forkcaster's client registry — verify the client's per-cast URL format (and optional native deeplink scheme), add the registry entry with a provenance comment and self-hosted logo, update the roster-guard tests, run the checks, and open a PR per CONTRIBUTING.md. Use whenever the user asks to add, register, support, or list a new Farcaster client app in forkcaster ("add Supercast", "support <app>", "can casts open in <app>?"), or to verify, fix, or update an existing client's URL format, deeplink scheme, logo, or signed-rule behavior. Do not skip this skill for anything that touches worker/client-registry.ts.
---

# Add a Farcaster client to forkcaster's registry

forkcaster renders a "Open in …" pill row on every cast page. The pills come from a
data registry — `worker/client-registry.ts` — and everything downstream picks new
entries up automatically: the renderer, the last-used cookie/badge, the `/t`
tracking allow-list, the rank pipeline, the MCP tool enum, and the transparency
tables. There are **no per-client code paths** and no copy to update (the MCP
landing card and README roster are deliberately generic).

Your job is therefore: **verify, then enter data, then update the tests that guard
the roster.** The hard constraint is the project's admission rule:

> **Entries arrive verified or not at all.** An unverified URL format is never
> added — not as a stub, not "temporarily". If you cannot verify, stop and report
> what you found and what is missing; do not write the entry.

Before writing anything, read `worker/client-registry.ts` (header comment +
existing entries — they are the style guide) and the roster-guard tests in
`worker/clients.test.ts`.

## Phase 1 — Verify the per-cast web URL

Find how the client addresses a single cast on the web. Look in this order, and
keep notes for the provenance comment:

1. **Open-source code** (strongest): the client's repo — route tables, deep-link
   handlers, share-sheet code. Cite repo + file path + what the handler does.
2. **Official docs** for a per-cast URL or share format.
3. **Live check** (always confirm, whatever the source): build the candidate URL
   for the house test cast and fetch it.

House test cast (real, used across the repo's tests):

- full hash: `0x895ecc7415208bfb6105a8cb675f391f19cb9e2c`
- short hash: `0x895ecc74`
- author: username `zoo`, fid `10215`

The live check passes when the client's own site renders *this* cast (say what
rendered: text snippet, cast card, etc.). A page that merely loads — a 200 that
isn't the cast — is a failed check.

### Choosing the template placeholders

| Placeholder | Value | Use when |
| --- | --- | --- |
| `{username}` | author username | route keys on handle |
| `{hash}` | hash exactly as requested (short or full) | route accepts short hashes — verify the documented minimum |
| `{fullHash}` | `0x` + 40 hex, as resolved | default choice; routes needing ≥8 hex or the full form |
| `{fullHashRaw}` | bare lowercase hex, no `0x` | app keys internally on raw hex (see quilcast) |
| `{fid}` | author fid | only when the format requires it; the pill is then skipped on fid-less surfaces (link-only fallback page) |

Default to `{fullHash}` when in doubt — it is always resolvable. Templates are
percent-encoded at resolution and HTML-escaped at render; never pre-escape.

### Outcomes

- **Verified per-cast web route** → `web` template, continue to Phase 2.
- **No web cast route, but a verified native scheme** → scheme-only entry:
  `web` is the homepage (an explicit stub) and the scheme is the only per-cast
  target (see quorum). Note in the comment why the stub is honest.
- **Neither verifiable** → **do not add the client.** Report findings.

## Phase 2 — Verify the native scheme (optional)

Add `deeplink: { scheme, androidPackage? }` only when all of these check out:

1. **The scheme exists**: `AndroidManifest.xml` (`<data android:scheme=…>`) and/or
   iOS `Info.plist` (`CFBundleURLSchemes`). Cite both when you have them.
2. **The app routes per-cast paths**: trace the scheme's deep-link handler —
   what does the app do with `scheme://<path>?<query>`? A scheme that only opens
   the home screen is not verifiable per-cast; don't use it.
3. **`androidPackage`** (optional): the package id from
   `https://<client-domain>/.well-known/assetlinks.json`. It makes Android clicks
   use the `intent://` form with a Chrome-native fallback to the web URL.

The pill's `href` is always the web URL; the scheme rides as a `data-scheme`
attribute attempted on mobile only. Note real limitations in the comment (quorum's
notes that the Feed tab needs a Farcaster account connected in-app).

## Phase 3 — The signed rule

Does the client hide authors who haven't signed Farcaster's social smart contract?
Set `requiresSigned: true` only if yes — the pill is then suppressed on pages of
known-unsigned authors (the check fails open; unknown state hides nothing). Test
against the known-unsigned author cast: `decent-artlu/0xbb54368f`. When unsure,
omit the flag — failing open is the designed default.

## Phase 4 — Write the registry entry

Append to `CLIENTS` in `worker/client-registry.ts`. **Append at the end**: registry
order is the fallback pill order, the rank tiebreak, and the MCP listing order, and
a new client is unranked until the offline rank job publishes its next snapshot.

```ts
// <Provenance paragraph: what was verified, against which sources (repo/file
// paths), what the live check rendered and when, and any limitations.>
{
    id: "<slug>",
    title: "<Display Name>",
    logoUrl: "/logos/<slug>.<svg|png>",
    web: "https://<host>/<path-with-{placeholders}>",
    // deeplink: { scheme: "<scheme>://…", androidPackage: "<pkg>" },  // only if verified
    // requiresSigned: true,  // only if verified
},
```

Rules the guardrail tests enforce:

- `id`: lowercase slug, `^[a-z0-9-]+$` — it is the cookie value, forever. If a
  client with this id was ever `suspended`, the id is never reused.
- `web`: must start `https://`.
- Every `{placeholder}` in `web`/`scheme` must be resolvable for the roster test
  to pass (only `{fid}` may be absent, and then the pill is skipped).
- Default `status` is `active`; you should not be adding `eol`/`suspended` entries
  in a "add client" task.

## Phase 5 — Logo

Add one self-hosted file at `public/logos/<slug>.svg` (or `.png` downscaled to
≤64px). Get the mark from the client's own assets (repo, app icon, press kit).
**Never hotlink**: a client-CDN logo would leak every visitor's IP to that client
on every page view — a tracking surface the transparency page would have to
declare — and hotlinks break (referrer checks, 403s). There is deliberately no
remote-fallback path; if the user asks for one, explain this and decline.

## Phase 6 — Update the roster-guard tests

`worker/clients.test.ts` asserts the roster **by design** — a new entry must fail
these tests until they are updated. Touch exactly:

1. `"every registry client renders today: no stale entries"` — add the id to the
   expected roster array (its loop then checks your `web` template resolves).
2. The two `clientsForPage` ordered-list assertions — add the id to both expected
   lists (or only the with-`fid` list if your template uses `{fid}`).
3. `"farcaster and quorum are the clients with native schemes"` — rename/extend
   with your id **only if you added a `deeplink`**.
4. Add a per-client test following the quorum pattern: assert the resolved scheme
   (and intent, if `androidPackage`) against the house cast, and that the pill
   `href` stays the web URL.

`cast-route.test.ts` needs no changes (its assertions are subsets) — optionally add
a `toContain('data-client="<slug>"')` to the action-row test.

## Phase 7 — Checks

```sh
bun run lint
bun run typecheck
bun test
```

All green before you go further. Optional sanity check: `bun run dev`, open the
printed local URL at `/zoo/0x895ecc74`, confirm the new pill renders with its logo
and correct target. **Never deploy** — `bun run deploy` is the owner's explicit,
manual step.

## Phase 8 — Pull request

Open a PR per `CONTRIBUTING.md`: describe what changed and why, and say how you
verified it — which commands ran, which URLs you checked, what rendered. Do not
push/deploy to production.

## Refusals and common traps

- Cannot verify the format → no entry; report what you tried (sources checked,
  live-check results) and ask how to proceed.
- "Just add it as a placeholder/stub" → decline; the stub policy exists so every
  pill works when clicked.
- Suspended/eol id reuse → never.
- Hotlinked or remote logo → decline (Phase 5).
- Editing the MCP landing card or README roster for a new client → don't; they
  are generic by design. The registry comment is where the roster knowledge lives.
- A template with `http://`, an unverified scheme, or an unknown placeholder
  (`{castId}`…) fails the guardrail tests — fix the entry, not the guardrail.
