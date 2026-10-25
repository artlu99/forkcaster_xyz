// Shared Analytics Engine SQL transport for the offline stats jobs
// (race-stats, client-rank, fid-race): one credential chain, one request
// and error shape, one sampling-weight helper. Dialect facts live in
// race-stats-lib.ts's header; live probes in scripts/probe/.
//
// ANALYTICS_* names are wrangler-inert on purpose: bun auto-loads .env
// into every `bun run` process, and CLOUDFLARE_* names collide with
// wrangler's own auth env (ciphertext values even broke `bun run deploy`).

export type Row = Record<string, unknown>;

export type AeCredentials = { accountId: string; apiToken: string };

export function aeCredentials(): AeCredentials {
	return {
		accountId:
			process.env.ANALYTICS_ACCOUNT_ID ??
			process.env.CLOUDFLARE_ACCOUNT_ID ??
			process.env.CF_ACCOUNT_ID ??
			"",
		apiToken:
			process.env.ANALYTICS_API_TOKEN ??
			process.env.CLOUDFLARE_API_TOKEN ??
			process.env.CF_API_TOKEN ??
			"",
	};
}

export const AE_MISSING_ENV_MESSAGE =
	"missing env — need CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, LMDIS_URL, LMDIS_REST_TOKEN (see .env.example; run via dotenvx)";

export async function aeSql(
	creds: AeCredentials,
	query: string,
): Promise<Row[]> {
	const res = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/analytics_engine/sql`,
		{
			method: "POST",
			headers: { authorization: `Bearer ${creds.apiToken}` },
			body: query,
			signal: AbortSignal.timeout(20000),
		},
	);
	const text = await res.text();
	if (res.status !== 200) {
		// SQL errors are plain text (422); auth errors are the v4 JSON envelope.
		let detail = text.slice(0, 300);
		try {
			const parsed = JSON.parse(text) as {
				errors?: Array<{ message?: string }>;
			};
			detail = parsed.errors?.map((e) => e.message).join("; ") ?? detail;
		} catch {
			// plain text already in detail
		}
		throw new Error(`AE SQL ${res.status}: ${detail}`);
	}
	const parsed: unknown = JSON.parse(text);
	const data = (parsed as { data?: unknown }).data;
	if (!Array.isArray(data)) {
		throw new Error(`AE SQL: unexpected response shape: ${text.slice(0, 200)}`);
	}
	return data as Row[];
}

/** AE SQL numbers arrive as strings — coerce, defusing non-finite junk. */
export function num(value: unknown): number {
	const n = Number(value ?? 0);
	return Number.isFinite(n) ? n : 0;
}

export const statsWindowHours = (): number =>
	Number(process.env.STATS_WINDOW_HOURS ?? "168") || 168;

export const wantsDry = (): boolean => process.argv.includes("--dry");
