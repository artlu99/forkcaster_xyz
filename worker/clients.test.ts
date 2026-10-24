/**
 * Client registry unit tests: template resolution, placeholder gating,
 * the signed rule, and native (mobile deeplink) targets. The full render
 * path (pills, badge, cookie, suppression) is covered by
 * cast-route.test.ts.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));
mock.module("react", () => require("preact/compat"));
mock.module("react-dom", () => require("preact/compat"));
mock.module("react/jsx-runtime", () => require("preact/jsx-runtime"));
mock.module("react/jsx-dev-runtime", () => require("preact/jsx-runtime"));

const { autoOpenUi, clientPill } = await import("./cast-actions.tsx");

import {
	CLIENTS,
	CLIENT_IDS,
	CLIENT_HOSTS,
	type ClientDefinition,
	blockedByLinkGate,
	clientsForPage,
	clientsForRoute,
	deeplinkTargets,
	findClient,
	kindSummary,
	missingVars,
	pointerClass,
	resolveLastUsed,
	resolveTemplate,
	targetDeeplinkTargets,
	targetFor,
	type TemplateVars,
} from "./client-registry.ts";
import {
	mergeClientCookie,
	parseClientCookie,
	serializeClientCookie,
} from "./clients.ts";
const VARS = {
	username: "zoo",
	hash: "0x895ecc74",
	fullHash: "0x895ecc7415208bfb6105a8cb675f391f19cb9e2c",
	fid: 10215,
};

describe("resolveTemplate", () => {
	test("interpolates every supported placeholder", () => {
		expect(
			resolveTemplate("u/{username}/h/{hash}/f/{fullHash}/id/{fid}", VARS),
		).toBe(
			"u/zoo/h/0x895ecc74/f/0x895ecc7415208bfb6105a8cb675f391f19cb9e2c/id/10215",
		);
	});

	test("percent-encodes interpolated values", () => {
		expect(
			resolveTemplate("https://x.test/{username}", {
				...VARS,
				username: "a b/c",
			}),
		).toBe("https://x.test/a%20b%2Fc");
	});

	test("leaves templates without placeholders untouched (homepage stubs)", () => {
		expect(resolveTemplate("https://x.test/", VARS)).toBe("https://x.test/");
	});
});

describe("missingVars", () => {
	test("reports placeholders whose value is absent", () => {
		expect(
			missingVars("https://x.test/{fid}/{fullHash}", {
				...VARS,
				fid: undefined,
			}),
		).toEqual(["fid"]);
	});

	test("passes templates whose placeholders are all satisfied", () => {
		expect(missingVars("https://x.test/c/{fullHash}", VARS)).toEqual([]);
	});
});

describe("client cookie", () => {
	test("parses legacy bare slug as unset", () => {
		expect(parseClientCookie("firefly")).toEqual({
			slug: "firefly",
			auto: undefined,
		});
	});
	test("parses slug + flag, including dot-usernames", () => {
		expect(parseClientCookie("firefly|auto-on")).toEqual({
			slug: "firefly",
			auto: "on",
		});
		expect(parseClientCookie("martinvr.eth|auto-off")).toEqual({
			slug: "martinvr.eth",
			auto: "off",
		});
	});
	test("parses flag-only values", () => {
		expect(parseClientCookie("|auto-on")).toEqual({
			slug: undefined,
			auto: "on",
		});
	});
	test("empty and garbage values degrade safely", () => {
		expect(parseClientCookie(undefined)).toEqual({});
		expect(parseClientCookie("")).toEqual({});
		expect(parseClientCookie("firefly|garbage")).toEqual({
			slug: "firefly",
			auto: undefined,
		});
	});
	test("serializes v2 and round-trips", () => {
		expect(serializeClientCookie({ slug: "firefly", auto: "on" })).toBe(
			"firefly|auto-on",
		);
		expect(serializeClientCookie({ auto: "off" })).toBe("|auto-off");
		const v = serializeClientCookie({ slug: "firefly", auto: "on" });
		expect(parseClientCookie(v)).toEqual({ slug: "firefly", auto: "on" });
	});
	test("merge keeps the slug and overwrites the flag", () => {
		expect(mergeClientCookie("zoo|auto-off", { auto: "on" })).toBe("zoo|auto-on");
		expect(mergeClientCookie(undefined, { auto: "on" })).toBe("|auto-on");
	});
	test("delay segment round-trips and is omitted at the default", () => {
		expect(parseClientCookie("firefly|auto-on|d2")).toEqual({
			slug: "firefly",
			auto: "on",
			delay: 2,
		});
		expect(parseClientCookie("firefly|d0")).toEqual({
			slug: "firefly",
			delay: 0,
		});
		expect(parseClientCookie("firefly%7Cauto-off%7Cd0")).toEqual({
			slug: "firefly",
			auto: "off",
			delay: 0,
		});
		expect(parseClientCookie("firefly|d2|auto-on")).toEqual({
			slug: "firefly",
			auto: "on",
			delay: 2,
		});
		expect(parseClientCookie("firefly|d9")).toEqual({
			slug: "firefly",
			auto: undefined,
		});
		expect(serializeClientCookie({ slug: "firefly", auto: "on", delay: 2 })).toBe(
			"firefly|auto-on|d2",
		);
		expect(serializeClientCookie({ slug: "firefly", delay: 0 })).toBe("firefly|d0");
		expect(serializeClientCookie({ slug: "firefly", auto: "on", delay: 5 })).toBe(
			"firefly|auto-on",
		);
		expect(parseClientCookie("firefly|auto-on")).toEqual({
			slug: "firefly",
			auto: "on",
		});
	});
	test("merge keeps the field the patch does not set", () => {
		expect(mergeClientCookie("zoo|auto-off|d2", { auto: "on" })).toBe(
			"zoo|auto-on|d2",
		);
		expect(mergeClientCookie("zoo|auto-on|d2", { delay: 0 })).toBe(
			"zoo|auto-on|d0",
		);
		expect(mergeClientCookie("zoo|auto-on|d2", { delay: 5 })).toBe("zoo|auto-on");
		expect(mergeClientCookie("firefly", { delay: 0 })).toBe("firefly|d0");
	});
});

describe("clientsForPage", () => {
	test("skips clients with unsatisfied optional placeholders ({fid})", () => {
		// Vibeshift needs the cast originator's fid (castFid): with no fid
		// in the vars it is skipped, the rest stay. Linkcast is absent from
		// both lists too: it is link-gated, and these calls pass no gate
		// argument (unknown ⇒ hidden — see the gate describe below).
		const withoutFid = clientsForPage(true, {
			...VARS,
			fid: undefined,
		}).map((c) => c.id);
		expect(withoutFid).toEqual([
			"farcaster",
			"quorum",
			"firefly",
			"quilcast",
			"neynar",
		]);
		// With the fid satisfied, the full roster is offered.
		const withFid = clientsForPage(true, VARS).map((c) => c.id);
		expect(withFid).toEqual([
			"farcaster",
			"quorum",
			"firefly",
			"quilcast",
			"neynar",
			"vibeshift",
		]);
	});

	test("hides requiresSigned clients only on a known signed:false", () => {
		const shown = clientsForPage(false, VARS).map((c) => c.id);
		expect(shown).not.toContain("farcaster");
		expect(shown).toContain("firefly");
		// Unknown (true) and fail-open (null-reduced) states show everything.
		expect(clientsForPage(true, VARS).map((c) => c.id)).toContain("farcaster");
	});

	test("every registry client renders today: no stale entries", () => {
		// Guards the roster against homepage stubs/removed clients sneaking back.
		expect(CLIENTS.map((c) => c.id)).toEqual([
			"farcaster",
			"quorum",
			"firefly",
			"quilcast",
			"neynar",
			"vibeshift",
			"linkcast",
		]);
		for (const client of CLIENTS) {
			expect(client.web).toBeDefined();
			expect(missingVars(client.web as string, VARS)).toEqual([]);
		}
	});
});

describe("findClient", () => {
	test("whitelists cookie values against the registry", () => {
		expect(findClient("firefly")?.title).toBe("Firefly");
		expect(findClient("not-a-client")).toBeUndefined();
		expect(findClient(undefined)).toBeUndefined();
	});
});

describe("deeplinkTargets", () => {
	const webClient: ClientDefinition = {
		id: "fixture",
		title: "Fixture",
		logoUrl: "/logos/firefly.png",
		web: "https://x.test/c/{fullHash}",
	};

	test("web-only clients have no native target", () => {
		expect(deeplinkTargets(webClient, VARS)).toEqual({});
		expect(deeplinkTargets({ ...webClient, web: undefined }, VARS)).toEqual({});
	});

	test("scheme clients resolve the template; href stays the web URL", () => {
		const client = {
			...webClient,
			deeplink: { scheme: "fixture://cast/{fullHash}" },
		};
		expect(deeplinkTargets(client, VARS)).toEqual({
			scheme: "fixture://cast/0x895ecc7415208bfb6105a8cb675f391f19cb9e2c",
		});
		const html = clientPill(client, VARS, false);
		// Canonical target is ALWAYS the web href, even when a scheme exists.
		expect(html).toContain(
			'href="https://x.test/c/0x895ecc7415208bfb6105a8cb675f391f19cb9e2c"',
		);
		expect(html).toContain(
			'data-scheme="fixture://cast/0x895ecc7415208bfb6105a8cb675f391f19cb9e2c"',
		);
		expect(html).not.toContain("data-intent");
	});

	test("androidPackage composes an intent URL alongside the scheme", () => {
		const client = {
			...webClient,
			deeplink: {
				scheme: "fixture://cast/{fullHash}",
				androidPackage: "xyz.fixture.app",
			},
		};
		expect(deeplinkTargets(client, VARS)).toEqual({
			scheme: "fixture://cast/0x895ecc7415208bfb6105a8cb675f391f19cb9e2c",
			intent:
				"intent://cast/0x895ecc7415208bfb6105a8cb675f391f19cb9e2c#Intent;scheme=fixture;package=xyz.fixture.app;S.browser_fallback_url=https%3A%2F%2Fx.test%2Fc%2F0x895ecc7415208bfb6105a8cb675f391f19cb9e2c;end",
		});
		const html = clientPill(client, VARS, true);
		// Both attributes ship: Android picks intent, iOS picks scheme.
		expect(html).toContain("data-intent=");
		expect(html).toContain("data-scheme=");
		// The badge coexists with native-target attributes.
		expect(html).toContain('class="pill-badge"');
	});

	test("a scheme without :// is never composed into an intent", () => {
		const client = {
			...webClient,
			deeplink: { scheme: "notascheme", androidPackage: "xyz.fixture.app" },
		};
		expect(deeplinkTargets(client, VARS)).toEqual({ scheme: "notascheme" });
	});
});

describe("roster native targets", () => {
	test("farcaster and quorum are the clients with native schemes", () => {
		const withScheme = CLIENTS.filter((c) => c.deeplink).map((c) => c.id);
		expect(withScheme).toEqual(["farcaster", "quorum"]);
	});

	test("farcaster's scheme resolves per cast; androidPackage composes intent", () => {
		const farcaster = findClient("farcaster");
		expect(farcaster).toBeDefined();
		// Scheme path = the web path (the app rewrites farcaster:// →
		// https://farcaster.xyz/ before parsing), full hash to satisfy the
		// app's 8-hex-digit minimum for short hashes.
		const targets = deeplinkTargets(farcaster as ClientDefinition, VARS);
		expect(targets.scheme).toBe(
			"farcaster://zoo/0x895ecc7415208bfb6105a8cb675f391f19cb9e2c",
		);
		// Verified via farcaster.xyz/.well-known/assetlinks.json.
		expect(targets.intent).toBe(
			"intent://zoo/0x895ecc7415208bfb6105a8cb675f391f19cb9e2c#Intent;scheme=farcaster;package=com.farcaster.mobile;S.browser_fallback_url=https%3A%2F%2Ffarcaster.xyz%2Fzoo%2F0x895ecc74;end",
		);
		const html = clientPill(farcaster as ClientDefinition, VARS, false);
		// Canonical target is ALWAYS the web href; native targets ride as
		// data attributes (both scheme and intent when a package is known).
		expect(html).toContain('href="https://farcaster.xyz/zoo/0x895ecc74"');
		expect(html).toContain(
			'data-scheme="farcaster://zoo/0x895ecc7415208bfb6105a8cb675f391f19cb9e2c"',
		);
		expect(html).toContain("data-intent=");
	});

	test("quorum's scheme routes the Feed tab to the cast thread", () => {
		const quorum = findClient("quorum");
		expect(quorum).toBeDefined();
		// Verified against quorum-mobile: /feed → FeedRedirect preserves
		// query params → FeedScreen reads castHashPrefix + username →
		// SocialFeedModal auto-opens the thread (full hash ⇒ direct
		// hypersnap lookup). The web href is a homepage stub — the scheme
		// is the only per-cast target.
		const targets = deeplinkTargets(quorum as ClientDefinition, VARS);
		expect(targets.scheme).toBe(
			"quorummobile://feed?castHashPrefix=0x895ecc7415208bfb6105a8cb675f391f19cb9e2c&username=zoo",
		);
		expect(targets.intent).toBe(
			"intent://feed?castHashPrefix=0x895ecc7415208bfb6105a8cb675f391f19cb9e2c&username=zoo#Intent;scheme=quorummobile;package=com.quilibrium.quorummobile;S.browser_fallback_url=https%3A%2F%2Fwww.quorummessenger.com%2F;end",
		);
		const html = clientPill(quorum as ClientDefinition, VARS, false);
		// Canonical target is ALWAYS the (stub) web href.
		expect(html).toContain('href="https://www.quorummessenger.com/"');
		expect(html).toContain(
			'data-scheme="quorummobile://feed?castHashPrefix=0x895ecc7415208bfb6105a8cb675f391f19cb9e2c&amp;username=zoo"',
		);
		expect(html).toContain("data-intent=");
	});
});

test("linkcast's web route emits the site-canonical bare hex", () => {
	const linkcast = findClient("linkcast");
	expect(linkcast).toBeDefined();
	// Verified live (Oct 2026): /cast/<40 bare hex> is the site's own
	// spelling and the 0x-prefixed form renders identically — the pill
	// emits {fullHashRaw}. Web-only (no assetlinks.json, no scheme), so
	// no native data attributes ship.
	const html = clientPill(linkcast as ClientDefinition, VARS, false);
	expect(html).toContain(
		'href="https://linkcast.xyz/cast/895ecc7415208bfb6105a8cb675f391f19cb9e2c"',
	);
	expect(html).toContain('data-client="linkcast"');
	expect(html).toContain('src="/logos/linkcast.svg"');
	expect(html).not.toContain("data-scheme");
	expect(html).not.toContain("data-intent");
});

// Registry guardrails — data-only registry edits (the common change) must
// fail here rather than fail agents/pills at runtime (registry change vectors).
describe("registry guardrails", () => {
	const KNOWN_VARS = new Set(["username", "hash", "fullHash", "fullHashRaw", "fid"]);
	const placeholders = (tpl: string): string[] =>
		[...tpl.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

	test("every template references only resolvable identity vars", () => {
		for (const client of CLIENTS) {
			const templates = [client.web, client.deeplink?.scheme];
			for (const tpl of templates) {
				if (tpl === undefined) continue;
				for (const name of placeholders(tpl)) {
					expect(KNOWN_VARS.has(name)).toBe(true);
				}
			}
		}
	});

	test("ids are slug-shaped and web URLs are https", () => {
		for (const client of CLIENTS) {
			expect(client.id).toMatch(/^[a-z0-9-]+$/);
			if (client.web !== undefined) {
				expect(client.web.startsWith("https://")).toBe(true);
			}
		}
	});

	test("{fullHashRaw} substitutes bare lowercase hex and gates with fullHash", () => {
		const tpl = "https://quilcast.com/c/{fullHashRaw}";
		const vars = {
			username: "zoo",
			hash: "0x895ecc74",
			fullHash: "0x895ECC7415208BFB6105A8CB675F391F19CB9E2C",
		};
		// derived from fullHash — never counted missing while fullHash exists
		expect(missingVars(tpl, vars)).toEqual([]);
		expect(resolveTemplate(tpl, vars)).toBe(
			"https://quilcast.com/c/895ecc7415208bfb6105a8cb675f391f19cb9e2c",
		);
	});

	test("suspended clients vanish from advertised ids, findClient, and the page", () => {
		const probe: ClientDefinition = {
			id: "guardrail-suspended",
			title: "Guardrail",
			logoUrl: "/logos/farcaster.svg",
			web: "https://example.com/cast",
			status: "suspended",
		};
		CLIENTS.push(probe);
		try {
			expect(CLIENT_IDS).not.toContain("guardrail-suspended");
			expect(findClient("guardrail-suspended")).toBeUndefined();
			expect(
				clientsForPage(true, {
					username: "zoo",
					hash: "0x895ecc74",
					fullHash: "0x895ecc7415208bfb6105a8cb675f391f19cb9e2c",
				}).some((c) => c.id === "guardrail-suspended"),
			).toBe(false);
		} finally {
			CLIENTS.pop();
		}
	});
});

// The external-link gate (`requiresExternalLinks`): a client that only
// serves casts carrying an external (non-ecosystem) URL embed — a
// links-only feed client. Offered only on casts known to carry an
// external link; UNKNOWN state hides the pill (fail-closed — the
// deliberate opposite of the signed rule, whose unknown fails open).
// One predicate, blockedByLinkGate, is shared verbatim with the MCP tool.
describe("external-link gate", () => {
	const gated: ClientDefinition = {
		id: "gate-links",
		title: "GateLinks",
		logoUrl: "/logos/farcaster.svg",
		web: "https://links.test/c/{fullHashRaw}",
		requiresExternalLinks: true,
	};
	const ungated: ClientDefinition = {
		id: "gate-open",
		title: "GateOpen",
		logoUrl: "/logos/farcaster.svg",
		web: "https://open.test/{fullHash}",
	};

	test("blockedByLinkGate is fail-closed on unknown cast state", () => {
		expect(blockedByLinkGate(gated, true)).toBe(false);
		expect(blockedByLinkGate(gated, false)).toBe(true);
		expect(blockedByLinkGate(gated, undefined)).toBe(true);
		// Clients without the flag are never gated.
		expect(blockedByLinkGate(ungated, true)).toBe(false);
		expect(blockedByLinkGate(ungated, false)).toBe(false);
		expect(blockedByLinkGate(ungated, undefined)).toBe(false);
	});

	test("clientsForPage offers a link-gated client only on known-external casts", () => {
		CLIENTS.push(gated);
		try {
			const ids = (externalLinks?: boolean) =>
				clientsForPage(true, VARS, externalLinks).map((c) => c.id);
			expect(ids(undefined)).not.toContain("gate-links"); // unknown ⇒ hidden
			expect(ids(false)).not.toContain("gate-links"); // internal-only ⇒ hidden
			expect(ids(true)).toContain("gate-links"); // external link ⇒ offered
			// The ungated roster is untouched by the third argument.
			expect(ids(undefined)).toContain("firefly");
			expect(ids(true)).toContain("firefly");
		} finally {
			CLIENTS.pop();
		}
	});

	test("linkcast is the roster's one link-gated client — by contract", () => {
		// Guards against ACCIDENTAL gating: exactly one entry may set
		// requiresExternalLinks. Linkcast's gate rests on the product
		// contract (links-only feed), not its implementation — the /cast/
		// route renders any cast today (see the registry comment).
		expect(
			CLIENTS.filter((c) => c.requiresExternalLinks).map((c) => c.id),
		).toEqual(["linkcast"]);
		// Fail-closed on the real entry: unknown cast state hides the pill.
		expect(
			blockedByLinkGate(findClient("linkcast") as ClientDefinition, undefined),
		).toBe(true);
	});

	test("CLIENT_HOSTS derives www-stripped web hosts in registry order", () => {
		expect(CLIENT_HOSTS).toEqual([
			"farcaster.xyz",
			"quorummessenger.com",
			"firefly.social",
			"quilcast.com",
			"explorer.neynar.com",
			"vibeshift.onchain.cooking",
			"linkcast.xyz",
		]);
	});
});

describe("kind targets (PLAN7 phase 1)", () => {
	// The registry is the single source of truth for verified client URL
	// facts. The cast fields (web/deeplink) ARE the cast target; profile,
	// feed, and channel targets are additive. Provenance lives in the
	// registry comments; the route tests (profile-route.test.ts,
	// channel-route.test.ts) pin the rendered bytes.

	test("targetFor: the cast kind is the existing web/deeplink fields", () => {
		const farcaster = findClient("farcaster") as ClientDefinition;
		expect(targetFor(farcaster, "cast")).toEqual({
			web: "https://farcaster.xyz/{username}/{hash}",
			deeplink: {
				scheme: "farcaster://{username}/{fullHash}",
				androidPackage: "com.farcaster.mobile",
			},
		});
		// No web = no cast target (scheme-only future entries).
		expect(
			targetFor({ ...farcaster, web: undefined, deeplink: undefined }, "cast"),
		).toBeUndefined();
	});

	test("targetFor: the verified non-cast targets are seeded", () => {
		const farcaster = findClient("farcaster") as ClientDefinition;
		// Profile + feed = farcaster.xyz's own username shape (the URL the
		// linktree's way out always used). Signed-gated via the client-level
		// requiresSigned flag — the fork's rule, generalized (§3).
		expect(targetFor(farcaster, "profile")).toEqual({
			web: "https://farcaster.xyz/{username}",
		});
		expect(targetFor(farcaster, "feed")).toEqual({
			web: "https://farcaster.xyz/{username}",
		});
		// Channel: the ~/ is load-bearing (bare form resolves as a profile
		// for the user "channel") — source-verified, PLAN6 §8.
		expect(targetFor(farcaster, "channel")).toEqual({
			web: "https://farcaster.xyz/~/channel/{channelId}",
			deeplink: {
				scheme: "farcaster://~/channel/{channelId}",
				androidPackage: "com.farcaster.mobile",
			},
		});

		const firefly = findClient("firefly") as ClientDefinition;
		// APK-verified (io.dimension.firefly 1.1.44 navigator): the scheme
		// and the farcaster.xyz universal link land on ONE channel route.
		expect(targetFor(firefly, "channel")).toEqual({
			web: "https://firefly.social/channel/farcaster/{channelId}",
			deeplink: {
				scheme: "firefly://FarcasterChannel/{channelId}",
				androidPackage: "io.dimension.firefly",
			},
		});
		expect(targetFor(firefly, "profile")).toBeUndefined();

		const quorum = findClient("quorum") as ClientDefinition;
		// Source-verified profile deep link (initialProfile →
		// SocialFeedModal; profileFid required, username optional) and
		// channelKey route. Scheme-only: the web href is the honest
		// homepage stub, coarse-only — the desktop build has neither page.
		expect(targetFor(quorum, "profile")).toEqual({
			web: "https://www.quorummessenger.com/",
			deeplink: {
				scheme: "quorummobile://feed?profileFid={fid}&profileUsername={username}",
				androidPackage: "com.quilibrium.quorummobile",
			},
			pointer: "coarse",
		});
		// Feed — VERIFIED (Oct 2026): the profileFid deep link IS the feed
		// surface (SocialFeedModal pushes ProfileView, which renders the
		// user's cast list via useFarcasterProfile) — profile and feed are
		// one merged surface in Quorum (PLAN7 §2), identical templates,
		// one provenance comment (the registry's). The list shows
		// top-level casts (the profile filters replies out — source
		// comment, quoted there); same stub/pointer/account caveats.
		expect(targetFor(quorum, "feed")).toEqual({
			web: "https://www.quorummessenger.com/",
			deeplink: {
				scheme: "quorummobile://feed?profileFid={fid}&profileUsername={username}",
				androidPackage: "com.quilibrium.quorummobile",
			},
			pointer: "coarse",
		});
		expect(targetFor(quorum, "channel")).toEqual({
			web: "https://www.quorummessenger.com/",
			deeplink: {
				scheme: "quorummobile://feed?channelKey={channelId}",
				androidPackage: "com.quilibrium.quorummobile",
			},
			pointer: "coarse",
		});

		const quilcast = findClient("quilcast") as ClientDefinition;
		// Owner-provided /u/ profile route; desktop scope (the unsigned way
		// out's assignment: Quilcast DESKTOP / Quorum MOBILE).
		expect(targetFor(quilcast, "profile")).toEqual({
			web: "https://quilcast.com/u/{username}",
			pointer: "fine",
		});
		expect(targetFor(quilcast, "feed")).toBeUndefined();
		expect(targetFor(quilcast, "channel")).toBeUndefined();
	});

	test("targetDeeplinkTargets: the shared composer reproduces the fork's intent exactly", () => {
		// The fork's hand-built intent (profile-page.tsx, pre-registry) —
		// byte-exact or the unsigned way out changes under the user.
		const quorum = findClient("quorum") as ClientDefinition;
		const target = targetFor(quorum, "profile") as ClientTarget;
		const vars: TemplateVars = { username: "decent-artlu", fid: 3319217 };
		expect(targetDeeplinkTargets(target, vars)).toEqual({
			scheme:
				"quorummobile://feed?profileFid=3319217&profileUsername=decent-artlu",
			intent:
				"intent://feed?profileFid=3319217&profileUsername=decent-artlu#Intent;scheme=quorummobile;package=com.quilibrium.quorummobile;S.browser_fallback_url=https%3A%2F%2Fwww.quorummessenger.com%2F;end",
		});
	});

	test("targetDeeplinkTargets: scheme-only target without a package = raw scheme", () => {
		const quorum = findClient("quorum") as ClientDefinition;
		const channel = targetFor(quorum, "channel") as ClientTarget;
		// The same route with the package stripped: no intent form, the raw
		// scheme alone (iOS/other attempt it directly).
		expect(
			targetDeeplinkTargets(
				{
					web: channel.web,
					deeplink: { scheme: "quorummobile://feed?channelKey={channelId}" },
				},
				{ channelId: "farcaster" },
			),
		).toEqual({ scheme: "quorummobile://feed?channelKey=farcaster" });
		expect(targetDeeplinkTargets({ web: "https://x.test/" }, {})).toEqual({});
	});

	test("pointerClass: scope renders the established CSS classes", () => {
		expect(pointerClass({ web: "https://x.test/" })).toBe("");
		expect(pointerClass({ web: "https://x.test/", pointer: "fine" })).toBe(
			" fine-only",
		);
		expect(pointerClass({ web: "https://x.test/", pointer: "coarse" })).toBe(
			" coarse-only",
		);
	});

	test("route-mode pills carry the target's pointer scope (PLAN6 §8 pattern)", () => {
		// The registry promises pointer scoping (ClientTarget.pointer) and
		// the channel row renders it — the stateful row must too, or a
		// coarse-only homepage-stub pill flings desktop users at a
		// marketing page (the exact outcome PLAN7 §11.3 rejects).
		const vars: TemplateVars = { username: "decent-artlu", fid: 3319217 };
		const quorum = findClient("quorum") as ClientDefinition;
		expect(clientPill(quorum, vars, false, "profile")).toContain(
			'class="pill client-pill coarse-only"',
		);
		expect(clientPill(quorum, vars, false, "feed")).toContain(
			'class="pill client-pill coarse-only"',
		);
		const quilcast = findClient("quilcast") as ClientDefinition;
		expect(clientPill(quilcast, vars, false, "profile")).toContain(
			'class="pill client-pill fine-only"',
		);
		// Cast mode stays byte-identical: cast targets never carry a
		// pointer scope, so the class attribute is unchanged.
		const farcaster = findClient("farcaster") as ClientDefinition;
		expect(
			clientPill(
				farcaster,
				{
					username: "zoo",
					hash: "0x895ecc74",
					fullHash: "0x895ecc7415208bfb6105a8cb675f391f19cb9e2c",
				},
				false,
			),
		).toContain('class="pill client-pill"');
	});

	test("clientsForRoute: channel kind — registry order matches the trio, unknown signed fails open", () => {
		const vars: TemplateVars = { channelId: "farcaster" };
		expect(clientsForRoute("channel", vars).map((c) => c.id)).toEqual([
			"farcaster",
			"quorum",
			"firefly",
		]);
		// Channels run no /signed check — every state must fail open.
		expect(clientsForRoute("channel", vars, null).map((c) => c.id)).toEqual([
			"farcaster",
			"quorum",
			"firefly",
		]);
	});

	test("clientsForRoute: profile unsigned — requiresSigned suppresses farcaster", () => {
		const vars: TemplateVars = { username: "decent-artlu", fid: 3319217 };
		expect(clientsForRoute("profile", vars, false).map((c) => c.id)).toEqual([
			"quorum",
			"quilcast",
		]);
	});

	test("clientsForRoute: signed true/null/undefined fail open — farcaster offered", () => {
		const vars: TemplateVars = { username: "zoo", fid: 10215 };
		const expected = ["farcaster", "quorum", "quilcast"];
		expect(clientsForRoute("profile", vars, true).map((c) => c.id)).toEqual(
			expected,
		);
		expect(clientsForRoute("profile", vars, null).map((c) => c.id)).toEqual(
			expected,
		);
		expect(clientsForRoute("profile", vars).map((c) => c.id)).toEqual(expected);
	});

	test("clientsForRoute: missingVars gate — fid-less vars skip quorum's profile target", () => {
		const vars: TemplateVars = { username: "decent-artlu" };
		expect(clientsForRoute("profile", vars, false).map((c) => c.id)).toEqual([
			"quilcast",
		]);
	});

	test("kind routes carry partial vars — channelId resolves, absent placeholders gate", () => {
		const vars: TemplateVars = { channelId: "farcaster" };
		expect(
			resolveTemplate("https://farcaster.xyz/~/channel/{channelId}", vars),
		).toBe("https://farcaster.xyz/~/channel/farcaster");
		expect(missingVars("https://farcaster.xyz/{username}/{hash}", vars)).toEqual([
			"username",
			"hash",
		]);
		// fullHashRaw derives from fullHash — optional-safe now.
		expect(missingVars("{fullHashRaw}", {})).toEqual(["fullHashRaw"]);
	});
});

describe("cookie v3 — per-kind slugs (PLAN7 phase 2)", () => {
	test("kind segments parse alongside the legacy tail", () => {
		const prefs = parseClientCookie("farcaster|auto-on|d3|p:firefly|f:linkcast");
		expect(prefs.slug).toBe("farcaster");
		expect(prefs.auto).toBe("on");
		expect(prefs.delay).toBe(3);
		expect(prefs.kinds).toEqual({ profile: "firefly", feed: "linkcast" });
	});

	test("v1/v2 cookies parse with kinds unset (bidirectional compat)", () => {
		expect(parseClientCookie("linkcast|auto-off")).toEqual({
			slug: "linkcast",
			auto: "off",
		});
		expect(parseClientCookie("linkcast")?.kinds).toBeUndefined();
		// %7C wire form decodes before segmenting.
		expect(parseClientCookie("farcaster%7Cp:firefly")).toEqual({
			slug: "farcaster",
			kinds: { profile: "firefly" },
		});
	});

	test("unknown segments are ignored — no c: segment exists (channels stateless)", () => {
		const prefs = parseClientCookie("farcaster|c:quorum|p:firefly");
		expect(prefs.kinds).toEqual({ profile: "firefly" });
		expect(serializeClientCookie(prefs)).toBe("farcaster|p:firefly");
	});

	test("serialize round-trips: flags, delay, then p/f in fixed order", () => {
		expect(
			serializeClientCookie({
				slug: "farcaster",
				auto: "on",
				delay: 2,
				kinds: { profile: "firefly", feed: "linkcast" },
			}),
		).toBe("farcaster|auto-on|d2|p:firefly|f:linkcast");
		expect(
			serializeClientCookie({ slug: "farcaster", kinds: { feed: "linkcast" } }),
		).toBe("farcaster|f:linkcast");
	});

	test("merge preserves kind segments (prefs writes only touch auto/delay)", () => {
		expect(mergeClientCookie("farcaster|auto-on|p:firefly", { auto: "off" })).toBe(
			"farcaster|auto-off|p:firefly",
		);
		expect(mergeClientCookie("farcaster|p:firefly", { delay: 0 })).toBe(
			"farcaster|d0|p:firefly",
		);
	});
});

describe("resolveLastUsed — flat inheritance (PLAN7 §5)", () => {
	const vars: TemplateVars = { username: "zoo", fid: 10215 };
	const offered = clientsForRoute("profile", vars, true);

	test("the kind's own slug wins when capable", () => {
		expect(
			resolveLastUsed({ slug: "quorum", kinds: { profile: "quilcast" } }, "profile", offered)
				?.id,
		).toBe("quilcast");
	});

	test("unset kind inherits the cast slug (flat — never another kind's)", () => {
		expect(resolveLastUsed({ slug: "quorum" }, "profile", offered)?.id).toBe(
			"quorum",
		);
		// Firefly has no profile target: a feed-only choice never carries.
		expect(
			resolveLastUsed({ slug: "quorum", kinds: { feed: "firefly" } }, "profile", offered)
				?.id,
		).toBe("quorum");
	});

	test("stale/ incapable slugs fall through, then to none", () => {
		// Own slug firefly lost its target → cast slug quorum still capable.
		expect(
			resolveLastUsed({ slug: "quorum", kinds: { profile: "firefly" } }, "profile", offered)
				?.id,
		).toBe("quorum");
		// Neither resolves → undefined (no banner, badgeless menu).
		expect(
			resolveLastUsed({ slug: "linkcast", kinds: { profile: "firefly" } }, "profile", offered),
		).toBeUndefined();
		expect(resolveLastUsed({}, "profile", offered)).toBeUndefined();
	});
});

describe("auto-open idle chip (PLAN7 §13)", () => {
	// auto=on but nothing resolves for this route: the non-redirect gets
	// ONE server-rendered line naming the armed client — never silence,
	// never a script (nothing times out, nothing opens).

	test("cast mode: a link-gated last-used client is named, no script", () => {
		// linkcast requires external links; a cast without one hides it —
		// the ON cookie must not silently do nothing.
		const { html, script } = autoOpenUi(
			{ slug: "linkcast", auto: "on" },
			true,
			VARS,
			false,
			false,
		);
		expect(html).toContain('data-auto="idle"');
		expect(html).toContain(
			"Auto-open: Linkcast isn&#39;t offered here — pick below",
		);
		expect(html).toContain('class="auto-settings" href="/"');
		expect(script).toBeUndefined();
	});

	test("route mode: an incapable cast slug is named on profile/feed", () => {
		const { html, script } = autoOpenUi(
			{ slug: "linkcast", auto: "on" },
			true,
			{ username: "decent-artlu", fid: 3319217 },
			false,
			undefined,
			{ kind: "profile", noun: "profiles" },
		);
		expect(html).toContain('data-auto="idle"');
		expect(html).toContain("Auto-open: Linkcast isn&#39;t offered here");
		expect(script).toBeUndefined();
	});

	test("a stale (unknown/suspended) slug names nothing — no chip", () => {
		expect(
			autoOpenUi({ slug: "not-a-client", auto: "on" }, true, VARS, false).html,
		).toBe("");
	});

	test("auto off/unset, ?noredirect, and resolvable states are unchanged", () => {
		// Off: the ordinary two-way chip (resolvable slug), never the idle
		// line.
		const off = autoOpenUi({ slug: "firefly", auto: "off" }, true, VARS, false);
		expect(off.html).toContain('data-auto="off"');
		expect(off.html).not.toContain('data-auto="idle"');
		// Off + unresolvable keeps its pre-chip silence too: no redirect
		// was ever promised in the off state.
		expect(
			autoOpenUi({ slug: "linkcast", auto: "off" }, true, VARS, false, false)
				.html,
		).toBe("");
		// noredirect keeps its own status chip path (no idle line).
		const noredirect = autoOpenUi(
			{ slug: "linkcast", auto: "on" },
			true,
			VARS,
			true,
			false,
		);
		expect(noredirect.html).not.toContain('data-auto="idle"');
		// Resolvable: the normal arming overlay, not the chip.
		const armed = autoOpenUi({ slug: "firefly", auto: "on" }, true, VARS, false);
		expect(armed.html).toContain('data-auto="on"');
		expect(armed.html).not.toContain('data-auto="idle"');
	});
});

describe("kindSummary — the landing's read-only per-kind line (PLAN7 §13)", () => {
	test("no remembered state: no line at all", () => {
		expect(kindSummary({})).toBeUndefined();
	});

	test("a cast slug alone: profiles and feeds display their inheritance", () => {
		expect(kindSummary({ slug: "quorum" })).toBe(
			"Casts: Quorum · Profiles: inherits casts → Quorum · Feeds: inherits casts → Quorum",
		);
	});

	test("own kind slugs win; inheritance only where a kind is unset", () => {
		expect(
			kindSummary({ slug: "quorum", kinds: { profile: "firefly" } }),
		).toBe(
			"Casts: Quorum · Profiles: Firefly · Feeds: inherits casts → Quorum",
		);
	});

	test("stale/unknown kind slugs fall back to the inheritance display", () => {
		// A removed target or retired id must not render a dead name —
		// the summary mirrors what resolution would actually do.
		expect(
			kindSummary({ slug: "quorum", kinds: { profile: "not-a-client" } }),
		).toBe(
			"Casts: Quorum · Profiles: inherits casts → Quorum · Feeds: inherits casts → Quorum",
		);
	});

	test("a suspended slug never renders (kill switch outranks memory)", () => {
		const suspended = CLIENTS.find((c) => c.id === "quorum");
		expect(suspended).toBeDefined();
		try {
			(suspended as ClientDefinition).status = "suspended";
			expect(kindSummary({ slug: "quorum" })).toBeUndefined();
		} finally {
			delete (suspended as ClientDefinition).status;
		}
	});
});
