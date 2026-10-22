// Shim identity-route probes — shim identity routes for the MCP resolution matrix.
//   /h/{longhash}      form B: does the cast carry author username + fid?
//   /u/{fid}           form C step 1: fid → username
//   /wc/{u}/{short}    known path (sanity: full hash + prefix match)
// Seed cast comes from shim's own casts-and-replies feed (a real, live cast).
// Run: bun scripts/probe/shim-mcp.ts

const base = "https://shim.artlu.xyz";

type Json = Record<string, unknown>;

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
	const res = await fetch(base + path, { signal: AbortSignal.timeout(10000) });
	const text = await res.text();
	try {
		return { status: res.status, body: JSON.parse(text) as Json };
	} catch {
		return { status: res.status, body: { raw: text.slice(0, 200) } };
	}
}

const rec = (body: unknown): Json => (typeof body === "object" && body !== null ? (body as Json) : {});
const str = (value: unknown): string => (typeof value === "string" ? value : "");

// 1. seed: a real live cast (try a few known-active usernames)
let seed: Json | undefined;
for (const username of ["farcaster", "artlu", "dwr"]) {
	const feed = await getJson(`/${username}/casts-and-replies?limit=1`);
	const casts = rec(feed.body).casts;
	const first = Array.isArray(casts) ? (casts[0] as Json | undefined) : undefined;
	if (first && str(first.hash).length === 40 + 2) {
		seed = first;
		console.log(`seed via /${username}/casts-and-replies`);
		break;
	}
	console.log(`  no cast from ${username} (status ${feed.status})`);
}
if (seed === undefined) {
	console.error("FAIL: no seed cast — shim feed paths returned nothing");
	process.exit(1);
}
const seedHash = str(seed.hash);
const seedUser = rec(seed.user);
console.log("seed cast:", {
	hash: seedHash,
	username: str(seedUser.username),
	fid: seedUser.fid,
});

// 2. form B — /h/{longhash}: author identity populated?
{
	const { status, body } = await getJson(`/h/${seedHash}`);
	const cast = rec(rec(body).cast);
	console.log("PROBE /h/{longhash}:", {
		status,
		keys: Object.keys(cast).sort().join(","),
		username: str(rec(cast.user).username),
		fid: rec(cast.user).fid ?? cast.fid,
		hashMatches: resolves(cast.hash, seedHash),
	});
}
function resolves(castHash: unknown, requested: string): boolean {
	return typeof castHash === "string" && castHash.toLowerCase().startsWith(requested.toLowerCase());
}

// 3. form C step 1 — /u/{fid}: fid → username
{
	const fid = rec(rec(seed.user)).fid ?? seed.fid;
	const { status, body } = await getJson(`/u/${String(fid)}`);
	console.log("PROBE /u/{fid}:", { status, body: JSON.stringify(body).slice(0, 200) });
}

// 4. /wc with a short hash — the known path, sanity-check prefix resolution
{
	const username = str(seedUser.username);
	const short = seedHash.slice(0, 10);
	const { status, body } = await getJson(`/wc/${username}/${short}`);
	const cast = rec(rec(body).cast);
	console.log("PROBE /wc/{u}/{short}:", {
		status,
		hash: str(cast.hash),
		hashMatches: resolves(cast.hash, short),
	});
}
