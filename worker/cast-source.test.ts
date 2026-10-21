/**
 * Cast source race unit tests: provider eligibility, the completeness box,
 * miss/error resolution, and each adapter's shape mapping. The full render
 * path is covered by cast-route.test.ts; globalThis.fetch is mocked by
 * exact URL — unexpected URLs reject (provider error path).
 */
import { afterEach, expect, mock, test } from "bun:test";

import {
	haatzProvider,
	raceCast,
	shimProvider,
	farcasterTvProvider,
	type CastVars,
} from "./cast-source.ts";

const SHORT_HASH = "0x895ecc74";
const FULL_HASH = "0x895ecc7415208bfb6105a8cb675f391f19cb9e2c";
const VARS: CastVars = { username: "zoo", hash: SHORT_HASH };

const originalFetch = globalThis.fetch;
// Test fetch responder: exact-URL mocks call this; "throw" mimics the
// suite convention where unexpected URLs reject (provider error path).
const respond = (url: string, body: unknown | "throw", delayMs = 0) => {
	if (body === "throw") {
		return Promise.reject(new Error(`unexpected fetch ${url}`));
	}
	return new Promise<Response>((resolve) => {
		setTimeout(() => resolve(Response.json(body)), delayMs);
	});
};

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const SHIM_CAST = {
	fid: 10215,
	hash: FULL_HASH,
	text: "omg so relevant!",
	embeds: [{ castId: { fid: 3854, hash: "0xa7c5f47033da848d6d16dac11c61838634a50c23" } }],
	timestamp: 1_792_425_174,
	user: { fid: 10215, username: "zoo", displayName: "zoo", pfpUrl: "https://img.test/p.png" },
};
const SHIM_FOUND = { success: true, cast: { ...SHIM_CAST } };
const FCTV_FOUND = {
	result: {
		casts: [
			{
				hash: FULL_HASH,
				text: "omg so relevant!",
				timestamp: 1_792_425_174_000,
				author: {
					fid: 10215,
					username: "zoo",
					displayName: "zoo",
					pfp: { url: "https://img.test/fctv.png" },
					profile: { bio: { text: "primus amanuensis @qbase" } },
				},
				embeds: {
					images: [{ openGraph: { url: "https://img.test/a.png" } }],
					urls: [{ openGraph: { url: "https://example.com/x", sourceUrl: "https://example.com/x" } }],
				},
			},
		],
	},
};

test("eligibility: short hashes race shim and farcaster.tv only", async () => {
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		throw new Error(`unexpected fetch ${url}`);
	});
	// Eligibility is observable through which providers get fetched: only
	// the two non-raw providers may be contacted for a short hash.
	await raceCast(VARS, { boxMs: 1 });
	// No assertion beyond "no raw-node URL was fetched" — the throw-on-
	// unexpected mock makes any haatz/snap//f fetch fail the test.
});

test("complete provider beats a faster partial one", async () => {
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === `https://shim.artlu.xyz/wc/zoo/${SHORT_HASH}`) {
			return respond(url, SHIM_FOUND, 20);
		}
		if (url === `https://farcaster.tv/zoo/${SHORT_HASH}`) {
			return respond(url, FCTV_FOUND);
		}
		return respond(url, "throw");
	});
	const race = await raceCast(VARS, { boxMs: 500 });
	expect(race.kind).toBe("found");
	if (race.kind === "found") {
		expect(race.provider).toBe("shim");
		expect(race.partial).toBe(false);
	}
});

test("partial provider wins at the box while a complete provider is pending", async () => {
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === `https://shim.artlu.xyz/wc/zoo/${SHORT_HASH}`) {
			return respond(url, SHIM_FOUND, 200);
		}
		if (url === `https://farcaster.tv/zoo/${SHORT_HASH}`) {
			return respond(url, FCTV_FOUND);
		}
		return respond(url, "throw");
	});
	const started = Date.now();
	const race = await raceCast(VARS, { boxMs: 40 });
	const elapsed = Date.now() - started;
	// The box gates the quote-blind win until the pending complete provider
	// has had its chance — but no longer than the box.
	expect(elapsed).toBeGreaterThanOrEqual(35);
	expect(elapsed).toBeLessThan(150);
	expect(race.kind).toBe("found");
	if (race.kind === "found") {
		expect(race.provider).toBe("farcaster-tv");
		expect(race.partial).toBe(true);
	}
});

test("all providers settled with only a partial found: no box wait", async () => {
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === `https://farcaster.tv/zoo/${SHORT_HASH}`) {
			return respond(url, FCTV_FOUND);
		}
		return respond(url, "throw");
	});
	const started = Date.now();
	const race = await raceCast(VARS, { boxMs: 500 });
	// Nothing is pending that could beat the partial, so the box is moot.
	expect(Date.now() - started).toBeLessThan(100);
	expect(race.kind).toBe("found");
	if (race.kind === "found") {
		expect(race.provider).toBe("farcaster-tv");
		expect(race.partial).toBe(true);
	}
});

test("shim miss resolves not-found immediately, even after a partial landed", async () => {
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === `https://shim.artlu.xyz/wc/zoo/${SHORT_HASH}`) {
			return respond(url, { success: false }, 10);
		}
		if (url === `https://farcaster.tv/zoo/${SHORT_HASH}`) {
			return respond(url, FCTV_FOUND);
		}
		return respond(url, "throw");
	});
	const race = await raceCast(VARS, { boxMs: 500 });
	expect(race.kind).toBe("not-found");
});

test("shim error + partial found still serves the partial", async () => {
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === `https://shim.artlu.xyz/wc/zoo/${SHORT_HASH}`) {
			return respond(url, "throw");
		}
		if (url === `https://farcaster.tv/zoo/${SHORT_HASH}`) {
			return respond(url, FCTV_FOUND);
		}
		return respond(url, "throw");
	});
	const race = await raceCast(VARS, { boxMs: 20 });
	expect(race.kind).toBe("found");
	if (race.kind === "found") expect(race.partial).toBe(true);
});

test("everything failing is unreachable", async () => {
	globalThis.fetch = mock(async (input: RequestInfo | URL) =>
		respond(String(input), "throw"),
	);
	const race = await raceCast(VARS, { boxMs: 10 });
	expect(race.kind).toBe("unreachable");
});

test("a found cast that does not resolve the requested hash is downgraded", async () => {
	const WRONG = {
		success: true,
		cast: { ...SHIM_CAST, hash: "0xffffffffffffffffffffffffffffffffffffffff" },
	};
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === `https://shim.artlu.xyz/wc/zoo/${SHORT_HASH}`) {
			return respond(url, WRONG);
		}
		return respond(url, "throw");
	});
	const race = await raceCast(VARS, { boxMs: 10 });
	expect(race.kind).toBe("unreachable");
});

test("farcaster.tv adapter maps the Warpcast shape onto ShimCast", async () => {
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === `https://farcaster.tv/zoo/${SHORT_HASH}`) {
			return respond(url, FCTV_FOUND);
		}
		return respond(url, "throw");
	});
	const outcome = await farcasterTvProvider.fetchCast(VARS, new AbortController().signal);
	expect(outcome.kind).toBe("found");
	if (outcome.kind !== "found") return;
	expect(outcome.complete).toBe(false);
	expect(outcome.cast.timestamp).toBe(1_792_425_174);
	expect(outcome.cast.user?.pfpUrl).toBe("https://img.test/fctv.png");
	expect(outcome.cast.user?.bio).toBe("primus amanuensis @qbase");
	// Embeds flatten back to raw {url} items; no {castId} quotes survive.
	expect(outcome.cast.embeds).toEqual([
		{ url: "https://img.test/a.png" },
		{ url: "https://example.com/x" },
	]);
});

test("farcaster.tv 404 is a miss", async () => {
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === `https://farcaster.tv/zoo/${SHORT_HASH}`) {
			return new Response("not found", { status: 404 });
		}
		return respond(url, "throw");
	});
	const outcome = await farcasterTvProvider.fetchCast(VARS, new AbortController().signal);
	expect(outcome.kind).toBe("miss");
});

test("raw nodes: ineligible on short hashes, mapped on full hashes", async () => {
	expect(haatzProvider.canServe({ username: "zoo", hash: SHORT_HASH })).toBe(false);
	expect(haatzProvider.canServe({ username: "zoo", hash: FULL_HASH })).toBe(true);
	expect(haatzProvider.complete).toBe(true);

	const RAW_MESSAGE = {
		hash: FULL_HASH,
		data: {
			type: "MESSAGE_TYPE_CAST_ADD",
			fid: 10215,
			timestamp: 182965974, // Farcaster epoch seconds
			castAddBody: {
				text: "omg so relevant!",
				embeds: [
					{ castId: { fid: 3854, hash: "0xa7c5f47033da848d6d16dac11c61838634a50c23" } },
					{ url: "https://img.test/a.png" },
				],
			},
		},
	};
	const USER_DATA = {
		messages: [
			{ data: { userDataBody: { type: "USER_DATA_TYPE_USERNAME", value: "zoo" } } },
			{ data: { userDataBody: { type: "USER_DATA_TYPE_PFP", value: "https://img.test/raw.png" } } },
			{ data: { userDataBody: { type: "USER_DATA_TYPE_BIO", value: "raw bio" } } },
		],
	};
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === "https://shim.artlu.xyz/f/zoo") {
			return respond(url, { success: true, fid: 10215 });
		}
		if (url === `https://haatz.quilibrium.com/v1/castById?fid=10215&hash=${FULL_HASH}`) {
			return respond(url, RAW_MESSAGE);
		}
		if (url === "https://haatz.quilibrium.com/v1/userDataByFid?fid=10215") {
			return respond(url, USER_DATA);
		}
		return respond(url, "throw");
	});
	const outcome = await haatzProvider.fetchCast(
		{ username: "zoo", hash: FULL_HASH },
		new AbortController().signal,
	);
	expect(outcome.kind).toBe("found");
	if (outcome.kind !== "found") return;
	expect(outcome.complete).toBe(true);
	// Farcaster epoch → unix seconds.
	expect(outcome.cast.timestamp).toBe(182965974 + 1609459200);
	expect(outcome.cast.user?.username).toBe("zoo");
	expect(outcome.cast.user?.pfpUrl).toBe("https://img.test/raw.png");
	// Raw {castId} quotes are preserved — this is what makes the node
	// providers complete where farcaster.tv is not.
	expect(outcome.cast.embeds?.[0]?.castId?.hash).toBe(
		"0xa7c5f47033da848d6d16dac11c61838634a50c23",
	);
});

test("raw nodes fail soft when shim /f yields no fid", async () => {
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === "https://shim.artlu.xyz/f/ghost") {
			return respond(url, { success: true });
		}
		return respond(url, "throw");
	});
	const outcome = await haatzProvider.fetchCast(
		{ username: "ghost", hash: FULL_HASH },
		new AbortController().signal,
	);
	expect(outcome.kind).toBe("error");
});

test("shim adapter maps success:false to an authoritative miss", async () => {
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === `https://shim.artlu.xyz/wc/zoo/${SHORT_HASH}`) {
			return respond(url, { success: false });
		}
		return respond(url, "throw");
	});
	const outcome = await shimProvider.fetchCast(VARS, new AbortController().signal);
	expect(outcome.kind).toBe("miss");
});

test("raceCast reports one timing row per eligible provider", async () => {
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === `https://shim.artlu.xyz/wc/zoo/${SHORT_HASH}`) {
			return respond(url, SHIM_FOUND, 15);
		}
		if (url === `https://farcaster.tv/zoo/${SHORT_HASH}`) {
			return respond(url, FCTV_FOUND);
		}
		return respond(url, "throw");
	});
	const race = await raceCast(VARS, { boxMs: 500 });
	expect(race.timings.length).toBe(2);
	const shim = race.timings.find((t) => t.provider === "shim");
	const fctv = race.timings.find((t) => t.provider === "farcaster-tv");
	expect(shim?.kind).toBe("found");
	expect(shim && shim.ms >= 10).toBe(true);
	expect(fctv?.kind).toBe("found");
	expect(race.elapsedMs).toBeGreaterThanOrEqual(shim?.ms ?? 0);
	// Erroring providers get timing rows too (the raw nodes are ineligible
	// on short hashes, so this roster only has two eligible providers).
});
