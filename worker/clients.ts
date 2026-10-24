// Last-used client cookie + auto-open preference (forkcaster-specific
// browser binding). The client registry itself lives in
// client-registry.ts — this module only serializes/parses the cookie.
//
// Server `Set-Cookie` (POST /prefs) keeps the preference exempt from
// Safari ITP's ~7-day cap on script-set cookies; pill clicks still write
// document.cookie directly (CLIENT_SCRIPT in cast-scripts.ts).

/** Cookie that remembers the visitor's last-used client. */
export const LAST_CLIENT_COOKIE = "fc_client";
/** 1 year. */
export const LAST_CLIENT_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Auto-open preference, carried in the same cookie
 * (`<slug>|auto-<on|off>|d<0-5>`). The delay segment is omitted at the
 * default of 5s. Unset auto = pausable countdown; on = arming overlay;
 * off = plain page. 0 redirects immediately.
 */
export type AutoOpen = "on" | "off";

/** Whole seconds. Missing or invalid means {@link AUTO_DELAY_DEFAULT}. */
export const AUTO_DELAY_MIN = 0;
export const AUTO_DELAY_MAX = 5;
export const AUTO_DELAY_DEFAULT = 5;

export interface ClientKindPrefs {
	/** Last-used client for profile routes (the `p:` segment). */
	profile?: string;
	/** Last-used client for feed routes (the `f:` segment). */
	feed?: string;
}

export interface ClientPrefs {
	slug?: string;
	auto?: AutoOpen;
	/** Saved wait in seconds. Absent means the default (5). */
	delay?: number;
	/**
	 * Per-route-kind last-used slugs (v3 tail segments `p:`/`f:`). An
	 * unset kind inherits the cast slug when capable — flat, never another
	 * kind's choice. Channels stay stateless: no `c:` segment
	 * exists.
	 */
	kinds?: ClientKindPrefs;
}

export interface ClientPrefsPatch {
	auto?: AutoOpen;
	delay?: number;
}

/**
 * v2 separator is "|" — Farcaster usernames can contain dots
 * (martinvr.eth), so "." would be ambiguous. "|" cannot appear in a
 * username and is a legal cookie-octet.
 */
const SEPARATOR = "|";
const FLAG_ON = "auto-on";
const FLAG_OFF = "auto-off";
const DELAY_SEGMENT = /^d([0-5])$/;
/** Kind segments: `p:<slug>` = profile, `f:<slug>` = feed. Anything else
 * (including a future `c:` — channels are stateless) is ignored. */
const KIND_SEGMENT = /^([pf]):([a-z0-9-]+)$/;
const KIND_KEYS = { p: "profile", f: "feed" } as const;

export function isAutoDelay(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= AUTO_DELAY_MIN &&
		value <= AUTO_DELAY_MAX
	);
}

/** Saved wait, or 5 when the cookie has no delay segment. */
export function clientDelay(prefs: ClientPrefs): number {
	return isAutoDelay(prefs.delay) ? prefs.delay : AUTO_DELAY_DEFAULT;
}

/** Parses a raw cookie value; tolerates a bare slug and garbage segments. */
export function parseClientCookie(raw: string | undefined): ClientPrefs {
	if (!raw) return {};
	// hono's setCookie encodes "|" as %7C; accept both forms.
	const value = raw.replace(/%7C/gi, SEPARATOR);
	const sep = value.indexOf(SEPARATOR);
	if (sep === -1) return { slug: value || undefined };
	const prefs: ClientPrefs = { slug: value.slice(0, sep) || undefined };
	for (const part of value.slice(sep + SEPARATOR.length).split(SEPARATOR)) {
		if (part === FLAG_ON) prefs.auto = "on";
		else if (part === FLAG_OFF) prefs.auto = "off";
		else {
			const delay = DELAY_SEGMENT.exec(part);
			if (delay) prefs.delay = Number(delay[1]);
			else {
				const kind = KIND_SEGMENT.exec(part);
				if (kind) {
					prefs.kinds ??= {};
					prefs.kinds[KIND_KEYS[kind[1] as keyof typeof KIND_KEYS]] =
						kind[2];
				}
			}
		}
	}
	return prefs;
}

/** Serializes prefs. Omits the delay segment at the default of 5s; kind
 * segments ride the tail in fixed p/f order after the flags. */
export function serializeClientCookie(prefs: ClientPrefs): string {
	const parts: string[] = [];
	if (prefs.auto) parts.push(prefs.auto === "on" ? FLAG_ON : FLAG_OFF);
	if (isAutoDelay(prefs.delay) && prefs.delay !== AUTO_DELAY_DEFAULT) {
		parts.push(`d${prefs.delay}`);
	}
	if (prefs.kinds?.profile) parts.push(`p:${prefs.kinds.profile}`);
	if (prefs.kinds?.feed) parts.push(`f:${prefs.kinds.feed}`);
	const slug = prefs.slug ?? "";
	if (parts.length === 0) return slug;
	return `${slug}${SEPARATOR}${parts.join(SEPARATOR)}`;
}

/** Keeps the slug, the kind segments, and any field the patch does not set. */
export function mergeClientCookie(
	current: string | undefined,
	patch: ClientPrefsPatch,
): string {
	const prev = parseClientCookie(current);
	return serializeClientCookie({
		slug: prev.slug,
		auto: patch.auto ?? prev.auto,
		delay: isAutoDelay(patch.delay) ? patch.delay : prev.delay,
		kinds: prev.kinds,
	});
}
