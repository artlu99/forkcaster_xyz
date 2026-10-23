---
name: add-client
description: Add a new Farcaster client app to forkcaster's client registry — verify the client's per-cast URL format (and optional native deeplink scheme), add the registry entry with a provenance comment and self-hosted logo, update the roster-guard tests, run the checks, and open a PR per CONTRIBUTING.md. Use whenever the user asks to add, register, support, or list a new Farcaster client app in forkcaster ("add Supercast", "support <app>", "can casts open in <app>?"), or to verify, fix, or update an existing client's URL format, deeplink scheme, logo, signed-rule, or external-link-gate behavior. Do not skip this skill for anything that touches worker/client-registry.ts.
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

Gate canonicals (the external-link gate, Phase 4 — real casts):

- **has an external link**: `kenny/0xa26d1f38` — full
  `0xa26d1f3861326cf24977995ec9dd24145e87a2fb`, fid `2210`, signed; one x.com
  URL embed. A links-only client must show this cast.
- **no external links**: `decent-artlu/0xbb54368f` — full
  `0xbb54368f40166b1be5f56048151adf2a3900a54a`, fid `3319217`, unsigned (this
  is also the Phase 3 cast); quote-only embed, no URL embeds. A links-only
  client must not show this cast. (Its cast-route test fixture deliberately
  models a URL embed to exercise the unfurl-fallback path — gate-test against
  the real shapes, not that fixture.)

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

## Phase 4 — The external-link gate (cast eligibility)

Some clients only serve a subset of casts. Linkcast, for example, is a links-only
feed: a cast with no outbound link simply does not exist there. If — and only if —
the client's product verifiably excludes link-less casts, set
`requiresExternalLinks: true`.

**Evidence bar** (same admission discipline as the URL format): confirm from the
client's own behavior that link-less casts are absent — e.g. its feed shows only
link-bearing casts, or a link-less cast is reported ineligible on its site.
Live-check both gate canonicals (see the house-cast block above):
`kenny/0xa26d1f38` must appear in the client; `decent-artlu/0xbb54368f` must
not. Record that evidence in the entry's provenance comment.

One predicate — `blockedByLinkGate` in `worker/client-registry.ts` — enforces the
flag on every surface, with the classifier living in `worker/cast-data.ts`
(`classifyUrl` / `hasExternalLinks`):

| Surface | Behavior |
| --- | --- |
| Pill row | hidden unless the cast carries ≥1 external URL embed |
| Unknown state (link-only fallback page — no cast data) | hidden — **fail-closed**, the deliberate opposite of `requiresSigned` (unknown author state fails open because unsigned authors are rare; unknown cast state proves nothing about eligibility, and link-less casts are the norm) |
| Auto-open | never redirects to a gated client on an ineligible cast (gated via `clientsForPage`) |
| MCP `get_cast_link` | omitted from `all`; a direct request answers the `client_ineligible` error |

What counts as **external**: everything at `farcaster.xyz`, `warpcast.com`,
`forkcaster.xyz`, `warpcats.com`, and every registry client's web host
(`CLIENT_HOSTS`, derived from the `web` templates — **your new client's host
becomes internal automatically** once you add the entry). Quote embeds and
images never qualify; unparseable URLs fail open as external. Known accepted
edge: a cast whose only link points at a client itself (e.g. a Linkcast
self-link) classifies internal and gets no pill, even if the client's own feed
would include it — accepted, do not special-case.

## Phase 5 — Write the registry entry

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
    // requiresExternalLinks: true,  // only if the client verifiably serves link casts only (Phase 4)
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

## Phase 6 — Logo

Add one self-hosted file at `public/logos/<slug>.svg` (or `.png` downscaled to
≤64px). Get the mark from the client's own assets (repo, app icon, press kit).
**Never hotlink**: a client-CDN logo would leak every visitor's IP to that client
on every page view — a tracking surface the transparency page would have to
declare — and hotlinks break (referrer checks, 403s). There is deliberately no
remote-fallback path; if the user asks for one, explain this and decline.

## Phase 7 — Update the roster-guard tests

`worker/clients.test.ts` asserts the roster **by design** — a new entry must fail
these tests until they are updated. Touch exactly:

1. `"every registry client renders today: no stale entries"` — add the id to the
   expected roster array (its loop then checks your `web` template resolves).
2. The two `clientsForPage` ordered-list assertions — add the id to both expected
   lists (or only the with-`fid` list if your template uses `{fid}`).
   **Exception — a `requiresExternalLinks` client (Phase 4):** these calls pass
   no gate argument, so a gated client is hidden in them (fail-closed) and must
   NOT be added to either list — adding it fails them by design. Leave the lists
   untouched and note the gated absence in the test comment (see linkcast);
   item 5 is where a gated client is recorded.
3. `"farcaster and quorum are the clients with native schemes"` — rename/extend
   with your id **only if you added a `deeplink`**.
4. Add a per-client test following the quorum pattern: assert the resolved scheme
   (and intent, if `androidPackage`) against the house cast, and that the pill
   `href` stays the web URL. For a web-only client, follow the linkcast pattern
   instead: the resolved `href`, `data-client`, and the logo `src`.
5. External-link gate (Phase 4 only): the one-gated-client guard in
   `clients.test.ts`'s gate describe (`linkcast is the roster's one link-gated
   client — by contract`) fails by design when you set `requiresExternalLinks` —
   extend its expected id array with your entry. The gate's behavior tests push
   a `"gate-links"` fixture in `clients.test.ts` / `mcp.test.ts`; the route-level
   gate test in `cast-route.test.ts` exercises the real linkcast slug
   end-to-end — optionally add a parallel assertion for your slug there.

`cast-route.test.ts` needs no changes (its assertions are subsets) — optionally add
a `toContain('data-client="<slug>"')` to the action-row test.

## Phase 8 — Checks

```sh
bun run lint
bun run typecheck
bun test
```

All green before you go further. Optional sanity check: `bun run dev`, open the
printed local URL at `/zoo/0x895ecc74`, confirm the new pill renders with its logo
and correct target. **Never deploy** — `bun run deploy` is the owner's explicit,
manual step.

## Phase 9 — Pull request

Open a PR per `CONTRIBUTING.md`: describe what changed and why, and say how you
verified it — which commands ran, which URLs you checked, what rendered. Do not
push/deploy to production.

## Refusals and common traps

- Cannot verify the format → no entry; report what you tried (sources checked,
  live-check results) and ask how to proceed.
- "Just add it as a placeholder/stub" → decline; the stub policy exists so every
  pill works when clicked.
- Setting `requiresExternalLinks` without eligibility evidence → decline; the
  gate is a product claim about which casts exist on the client, not a hunch
  (Phase 4).
- Suspended/eol id reuse → never.
- Hotlinked or remote logo → decline (Phase 6).
- Editing the MCP landing card or README roster for a new client → don't; they
  are generic by design. The registry comment is where the roster knowledge lives.
- A template with `http://`, an unverified scheme, or an unknown placeholder
  (`{castId}`…) fails the guardrail tests — fix the entry, not the guardrail.
