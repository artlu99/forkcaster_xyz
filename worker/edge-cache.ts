// Edge-shell cache — the invariant, the gate, and the put/get for caching
// server-rendered cast-page shells at the edge (Workers Cache API).
//
// THE INVARIANT (decided Oct 2026, before rollout): a cached shell must be
// byte-indistinguishable from the cold server render a link-preview bot
// would immortalize. Concretely, only a FOUND render with canonical body
// text may enter the cache — link-only (fail-open) pages, 404 consensus
// misses, 503s, text-blind wins (mention-stripped raw text; a body can't
// self-heal) and JSON variants pass through fresh, every time. Negative
// caching would rebuild the SPOF in disguise: under collective parity a
// miss is exactly what a pending fleet leg might rescue. And since OG meta
// derives only from the found cast, every cached shell is preview-identical
// to a cold render — bots warm the cache with the preview they would have
// cached anyway.
//
// The second half of the gate is the REQUEST side: only personalization-
// free requests participate. A request carrying the fc_client cookie gets
// the server-rendered personalized page (badge / auto-open / pill order)
// exactly as before — today that means a pass-through; when personalization
// moves client-side, cookie-holders join the cache with their badge
// applied after paint. TTL: 12h (s-maxage=43200) — cast content is
// immutable, so TTL is a hit-rate knob (global click tails run on
// timezone offsets), not a freshness knob. SHELL_SALT is the manual purge:
// bump it when a deploy fixes a render/script bug that cached shells must
// pick up (asset URLs in the shell are static paths and self-heal on
// deploy; inline scripts do not).

/** Edge TTL for a cast shell: 12h — covers the global, timezone-staggered
 * click tail of a share. The only knob, since casts are immutable. */
export const SHELL_TTL_SECONDS = 43_200;

/** Edge TTL for profile-family shells: 10 min — profiles are MUTABLE
 * (bio/pfp/signed flip) and their owners check their own pages, so this
 * is a freshness knob AND a hit-rate knob. */
export const PROFILE_SHELL_TTL_SECONDS = 600;

/** Cache-key salt — the invalidation tool. Bump to drop every shell at
 * once (there is no global purge for the Workers Cache API). v2: purges
 * shells cached from text-blind raw-node wins, whose body text was missing
 * mention names (the race now holds those wins until canonical text is
 * available — and never caches them). */
export const SHELL_SALT = "v2";

/** Request-side gate: only HTML requests may read or fill the shell
 * cache. JSON variants bypass entirely. (Personalization is client-side
 * on cast pages, so cookies no longer affect eligibility.) */
export function shellRequestEligible(facts: { wantsJson: boolean }): boolean {
	return !facts.wantsJson;
}

export type ShellOutcome = {
	status: number;
	kind: "found" | "not-found" | "unreachable";
	partial: boolean;
	/**
	 * False marks a text-blind win (body text possibly missing mention
	 * names). Absent/true ⇒ canonical. The cast race sets it; the profile
	 * family (shim-only) is canonical by construction and omits it.
	 */
	textCanonical?: boolean;
};

/** Response-side gate — THE INVARIANT: only a found render whose body text
 * is canonical is worth immortalizing. Quote-blind partials are safe to
 * cache because their OG meta is complete (meta never depends on quotes)
 * and their bodies self-heal per view (QUOTE_FILL_SCRIPT re-fetches the
 * fresh no-store fragment on every page view) — nothing stale is ever
 * shown. Text-blind wins are NOT: their body text may be missing mention
 * names and nothing can heal a body, so they pass through fresh every
 * time. Link-only (fail-open), consensus misses, outages and JSON variants
 * never enter the cache, so a stale or empty preview can never be served
 * from it. */
export function shellWorthCaching(outcome: ShellOutcome): boolean {
	return (
		outcome.status === 200 &&
		outcome.kind === "found" &&
		outcome.textCanonical !== false
	);
}

/**
 * The cache key: salted and query-free. Incoming queries (fbclid, tgWeb*,
 * ?format=json, …) never fork keys — a link shared through any parameter-
 * adding surface hits the one shell. The salt rides as a query so distinct
 * salt eras never collide.
 */export function shellCacheKey(url: URL): Request {
	return new Request(`${url.origin}${url.pathname}?shell=${SHELL_SALT}`);
}

type EdgeCache = Cache;

/** Resolved lazily — the Workers runtime has it always; tests install a
 * mock on globalThis.caches after import, and environments without any
 * (bun's bare test globals) make every get/put a no-op. */
const edgeCache = (): EdgeCache | undefined =>
	(globalThis as unknown as { caches?: { default: EdgeCache } }).caches?.default;

/**
 * Serve a cached shell, or undefined. Hit responses are rewritten
 * `cache-control: no-store` — the edge already did the caching; browsers
 * must pass every click through so cookie-holders' next personalized
 * render (and any fresh shell) is what they see.
 */
export async function getShell(key: Request): Promise<Response | undefined> {
	const cache = edgeCache();
	if (!cache) return undefined; // no Cache API (tests) — pass through
	try {
		const hit = await cache.match(key);
		if (!hit) return undefined;
		const headers = new Headers(hit.headers);
		headers.set("cache-control", "no-store");
		headers.set("x-forkcaster-shell", "hit");
		return new Response(hit.body, { status: hit.status, headers });
	} catch {
		return undefined; // the cache is an optimization, never a dependency
	}
}

/**
 * Store a shell (the caller has already passed BOTH gates and clones the
 * response — the visitor's copy is untouched). Best-effort by contract:
 * any failure is swallowed, because a cache miss only costs a render.
 */
export async function putShell(
	key: Request,
	response: Response,
	ttlSeconds: number = SHELL_TTL_SECONDS,
): Promise<void> {
	const cache = edgeCache();
	if (!cache) return;
	try {
		const headers = new Headers(response.headers);
		headers.set("cache-control", `public, s-maxage=${ttlSeconds}`);
		headers.set("x-forkcaster-shell", "fill");
		await cache.put(
			key,
			new Response(response.body, { status: response.status, headers }),
		);
	} catch {
		// Cache is best-effort — a failed put is invisible to the visitor.
	}
}
