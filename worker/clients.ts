// Last-used client cookie + auto-open preference (forkcaster-specific
// browser binding). The client registry itself lives in
// client-registry.ts — this module only serializes/parses the cookie.
//
// Server `Set-Cookie` (POST /prefs) keeps the preference exempt from
// Safari ITP's ~7-day cap on script-set cookies; pill clicks still write
// document.cookie directly (CLIENT_SCRIPT in cast-page.tsx).

/** Cookie that remembers the visitor's last-used client. */
export const LAST_CLIENT_COOKIE = "fc_client";
/** 1 year. */
export const LAST_CLIENT_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Auto-open preference, carried in the same cookie (v2 value:
 * `<slug>|auto-<on|off>`). Unset = 5s pausable countdown; on = short
 * circuit; off = plain page.
 */
export type AutoOpen = "on" | "off";

export interface ClientPrefs {
	slug?: string;
	auto?: AutoOpen;
}

/**
 * v2 separator is "|" — Farcaster usernames can contain dots
 * (martinvr.eth), so "." would be ambiguous. "|" cannot appear in a
 * username and is a legal cookie-octet.
 */
const SEPARATOR = "|";
const FLAG_ON = "auto-on";
const FLAG_OFF = "auto-off";

/** Parses a raw cookie value; tolerates v1 (bare slug) and garbage. */
export function parseClientCookie(raw: string | undefined): ClientPrefs {
	if (!raw) return {};
	// hono's setCookie encodes "|" as %7C; accept both forms.
	const value = raw.replace(/%7C/gi, SEPARATOR);
	const sep = value.indexOf(SEPARATOR);
	if (sep === -1) return { slug: value || undefined };
	const flag = value.slice(sep + SEPARATOR.length);
	const auto: AutoOpen | undefined =
		flag === FLAG_ON ? "on" : flag === FLAG_OFF ? "off" : undefined;
	return { slug: value.slice(0, sep) || undefined, auto };
}

/** Serializes prefs to the v2 cookie value (omit slug for flag-only). */
export function serializeClientCookie(prefs: ClientPrefs): string {
	const slug = prefs.slug ?? "";
	if (!prefs.auto) return slug;
	const flag = prefs.auto === "on" ? FLAG_ON : FLAG_OFF;
	return `${slug}${SEPARATOR}${flag}`;
}

/** Keeps the current slug, overwrites the auto-open flag. */
export function mergeClientCookie(
	current: string | undefined,
	auto: AutoOpen,
): string {
	const { slug } = parseClientCookie(current);
	return serializeClientCookie({ slug, auto });
}
