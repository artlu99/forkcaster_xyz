// Phase 0 probe — differential: does the token hold Account Analytics:Read?
// The AE SQL endpoint 403s (code 10000) with a *valid, active* Account Owned
// Token. The GraphQL Analytics API consumes the same "Account Analytics"
// permission group, so:
//   GraphQL OK  + AE SQL 403 → token has the scope; the SQL endpoint
//                              rejects account-owned tokens → use a User token.
//   GraphQL 403 + AE SQL 403 → token lacks Account Analytics:Read entirely.
// Prints only the API responses — never the token.
//
// Run: dotenvx run -- bun scripts/probe/cf-graphql.ts

const account =
	process.env.ANALYTICS_ACCOUNT_ID ??
	process.env.CLOUDFLARE_ACCOUNT_ID ??
	process.env.CF_ACCOUNT_ID ??
	"";
const token =
	process.env.ANALYTICS_API_TOKEN ??
	process.env.CLOUDFLARE_API_TOKEN ??
	process.env.CF_API_TOKEN ?? "";
if (account === "" || token === "") {
	console.error(
		"missing CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN — load via dotenvx",
	);
	process.exit(1);
}

const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
	method: "POST",
	headers: {
		"content-type": "application/json",
		authorization: `Bearer ${token}`,
	},
	body: JSON.stringify({
		query: `query { viewer { accounts(filter: {accountTag: "${account}"}) { accountTag } } }`,
	}),
	signal: AbortSignal.timeout(15000),
});
console.log(
	`graphql → ${res.status} ${JSON.stringify(await res.json().catch(() => ({})))}`,
);
