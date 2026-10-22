// Phase 0 probe — Cloudflare API token self-check (scripts/probe/cf-token.ts)
// AE SQL returned 403 code 10000 ("Authentication error") for every query.
// This distinguishes "invalid token string" from "valid token, wrong
// scope/account" by hitting the token verify endpoints directly.
// Prints token id/status and length only — never the secret.
//
// Run: dotenvx run -- bun scripts/probe/cf-token.ts

const account =
	process.env.ANALYTICS_ACCOUNT_ID ??
	process.env.CLOUDFLARE_ACCOUNT_ID ??
	process.env.CF_ACCOUNT_ID ??
	"";
const token =
	process.env.ANALYTICS_API_TOKEN ??
	process.env.CLOUDFLARE_API_TOKEN ??
	process.env.CF_API_TOKEN ?? "";
if (token === "") {
	console.error(
		"missing CLOUDFLARE_API_TOKEN — load via dotenvx (see .env.example)",
	);
	process.exit(1);
}

console.log(
	`token length: ${token.length}, leading/trailing whitespace: ${/^\s|\s$/.test(token)}`,
);

const get = async (url: string): Promise<void> => {
	const res = await fetch(url, {
		headers: { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(10000),
	});
	const body: unknown = await res.json().catch(() => ({}));
	console.log(
		`${url.split("client/v4")[1]} → ${status(res)} ${JSON.stringify(body)}`,
	);
	function status(r: Response): string {
		return String(r.status);
	}
};

// User tokens (dashboard-created tokens are usually these)
await get("https://api.cloudflare.com/client/v4/user/tokens/verify");
// Account-owned tokens
if (account !== "") {
	await get(
		`https://api.cloudflare.com/client/v4/accounts/${account}/tokens/verify`,
	);
} else {
	console.log("account tokens/verify skipped — no CLOUDFLARE_ACCOUNT_ID");
}
