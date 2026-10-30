// biome-ignore-all lint/suspicious/noImplicitAnyLet: the body ships to
// browsers verbatim (serialized via toString in cast-scripts.ts) — ES5
// style is deliberate, not sloppy.
// biome-ignore-all lint/correctness/noInnerDeclarations: same — embeddable
// ES5 keeps declarations where the old parsers expect them.

// The client-side auto-open DECISION — the one piece of the shell
// personalization push that is serialized into an inline script, so it is
// written to be embeddable:
//
//   - the body is plain ES5 (var, functions, regex literals, no arrows,
//     no template literals, no optional chaining) because
//     Function.prototype.toString() hands the source to every browser
//     that renders the page;
//   - the function is fully SELF-CONTAINED — everything arrives as
//     parameters, no module-scope references — so minifiers can rename
//     freely and the serialized source never dangles;
//
// which is what lets bun fixture-test the exact code browsers run
// (import + direct call here; the script embeds `shellAutoDecision` via
// toString in cast-scripts.ts). The DOM wiring around it stays in the
// script and is smoke-covered.

/** One offered pill, as the script reads it off the DOM. */
export interface ShellPill {
	slug: string;
	url: string;
	scheme: string;
	intent: string;
}

export type ShellAutoVariant = "overlay" | "banner" | "chip" | "idle";

export interface ShellAutoDecision {
	/** Which initial box to render. */
	variant: ShellAutoVariant;
	/** The data-auto mode — AUTO_SCRIPT branches on it verbatim. */
	mode: "on" | "unset" | "off" | "noredirect";
	/** The resolved (or, for idle, the armed-but-unoffered) slug. */
	slug: string;
	url: string;
	scheme: string;
	intent: string;
	/** Saved wait in seconds; 5 when the cookie carries no valid segment. */
	delay: number;
	/** Whether the auto flag is on (drives chip pressed-state and copy). */
	prefOn: boolean;
}

/**
 * Decide a page's auto-open state from the raw fc_client cookie value and
 * the page's offered pills (server-gated: signed/link gates are already
 * reflected in the pill set — the decision only ever resolves within it).
 * `kind` picks the resolution: "cast" resolves FLAT (the head slug);
 * "profile"/"feed" prefer their own kind segment (`p:`/`f:`) and inherit
 * the head slug when absent — flat, never another kind's choice. Null ⇒
 * render nothing (no cookie, stale/unknown slug with no arming, or
 * off/unresolved — the old server renderer's silence).
 */
export function shellAutoDecision(
	cookieRaw: string | undefined,
	pills: ShellPill[],
	noredirect: boolean,
	kind: "cast" | "profile" | "feed",
): ShellAutoDecision | null {
	if (!cookieRaw) return null;
	// hono's setCookie encodes "|" as %7C; accept both forms. The head is
	// the last-used slug — usernames contain dots, never pipes.
	var value = String(cookieRaw).replace(/%7C/gi, "|");
	var sep = value.indexOf("|");
	var slug = sep === -1 ? value : value.slice(0, sep);
	var auto;
	var delay = 5;
	var kindSlug = "";
	if (sep !== -1) {
		var parts = value.slice(sep + 1).split("|");
		for (var i = 0; i < parts.length; i++) {
			var part = parts[i];
			if (part === "auto-on") auto = "on";
			else if (part === "auto-off") auto = "off";
			else if (/^d[0-5]$/.test(part)) delay = Number(part.charAt(1));
			else if (kind !== "cast" && part.charAt(0) === kind.charAt(0) && part.charAt(1) === ":") {
				kindSlug = part.slice(2);
			}
		}
	}
	if (!slug) return null;
	var candidate = kind === "cast" ? slug : kindSlug || slug;
	var pill = null;
	for (var j = 0; j < pills.length; j++) {
		if (pills[j] && pills[j].slug === candidate) {
			pill = pills[j];
			break;
		}
	}
	if (!pill) {
		// Armed but unoffered (stale slug, signed/link-gated out): the idle
		// chip explains — only in the arming state, where the silence would
		// otherwise read as a broken redirect. Generic copy by decision.
		if (auto === "on" && !noredirect) {
			return {
				variant: "idle",
				mode: "on",
				slug: candidate,
				url: "",
				scheme: "",
				intent: "",
				delay: delay,
				prefOn: true,
			};
		}
		return null;
	}
	var mode: ShellAutoDecision["mode"] = noredirect
		? "noredirect"
		: auto === "on"
			? "on"
			: auto === "off"
				? "off"
				: "unset";
	var variant: ShellAutoDecision["variant"] =
		mode === "on" ? "overlay" : mode === "unset" ? "banner" : "chip";
	return {
		variant: variant,
		mode: mode,
		slug: candidate,
		url: pill.url || "",
		scheme: pill.scheme || "",
		intent: pill.intent || "",
		delay: delay,
		prefOn: auto === "on",
	};
}
