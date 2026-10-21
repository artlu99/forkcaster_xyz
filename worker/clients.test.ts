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

const { clientPill } = await import("./cast-page.tsx");

import {
	CLIENTS,
	type ClientDefinition,
	clientsForPage,
	deeplinkTargets,
	findClient,
	missingVars,
	resolveTemplate,
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

describe("clientsForPage", () => {
	test("skips clients with unsatisfied optional placeholders ({fid})", () => {
		const offered = clientsForPage(true, { ...VARS, fid: undefined }).map(
			(c) => c.id,
		);
		// Every registry client today has a satisfiable template —
		// farcaster/firefly/quilcast/neynar/vibeshift stay.
		expect(offered).toEqual([
			"farcaster",
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
			"firefly",
			"quilcast",
			"neynar",
			"vibeshift",
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
	test("farcaster is the only client with a native scheme", () => {
		const withScheme = CLIENTS.filter((c) => c.deeplink).map((c) => c.id);
		expect(withScheme).toEqual(["farcaster"]);
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
});
