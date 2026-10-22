// Phase 0 probe — Analytics Engine SQL API (scripts/probe/ae.ts)
// Validates the plan's SQL assumptions against the live RACE_STATS dataset:
// dataset visibility, sampling activity, the dialect bets (position needle
// syntax, countIf/sumIf, quantileExactWeighted, substring ms extraction),
// blob1 cardinality, and the response format.
// Prints statuses, row previews and aggregate numbers only — never credentials.
//
// Run: dotenvx run -- bun scripts/probe/ae.ts

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
		"missing CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN — load via dotenvx (see .env.example)",
	);
	process.exit(1);
}

const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`;

async function sql(query: string): Promise<{ status: number; text: string }> {
	const res = await fetch(endpoint, {
		method: "POST",
		headers: { authorization: `Bearer ${token}` },
		body: query,
		signal: AbortSignal.timeout(20000),
	});
	return { status: res.status, text: await res.text() };
}

function parseRows(text: string): Record<string, unknown>[] {
	const t = text.trim();
	if (t === "") return [];
	try {
		const j: unknown = JSON.parse(t);
		// Success bodies are a pretty-printed envelope {meta, data, rows, …};
		// the actual rows live under .data. Integer values are string-typed.
		if (j !== null && typeof j === "object" && !Array.isArray(j)) {
			const data = (j as { data?: unknown }).data;
			if (Array.isArray(data)) return data as Record<string, unknown>[];
		}
		return Array.isArray(j)
			? (j as Record<string, unknown>[])
			: [j as Record<string, unknown>];
	} catch {
		try {
			return t
				.split(/\r?\n/)
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		} catch {
			// Non-JSON body (plain-text SQL error) — surface it, don't crash.
			return [{ nonJsonBody: t.slice(0, 300) }];
		}
	}
}

function report(name: string, ok: boolean, detail?: unknown): void {
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`,
	);
}

function preview(text: string, max = 300): string {
	const t = text.trim();
	return t.length <= max ? t : `${t.slice(0, max)}…`;
}

// --- 1. dataset discovery ---
{
	const { status, text } = await sql("SHOW TABLES");
	report(
		"SHOW TABLES lists RACE_STATS",
		status === 200 && /RACE_STATS/i.test(text),
		{
			status,
			body: preview(text),
		},
	);
}

// --- 2. volume + sampling activity ---
for (const hours of [1, 24, 168]) {
	const { status, text } = await sql(
		`SELECT count() AS n, sum(_sample_interval) AS weighted, max(_sample_interval) AS maxSampleInterval FROM RACE_STATS WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR`,
	);
	report(`volume ${hours}h`, status === 200, {
		status,
		row: parseRows(text)[0],
		body: status === 200 ? undefined : preview(text),
	});
}

// --- 3. dataset bounds (retention in practice) ---
{
	const { status, text } = await sql(
		"SELECT min(timestamp) AS earliest, max(timestamp) AS latest, count() AS n FROM RACE_STATS",
	);
	report("dataset bounds", status === 200, { status, row: parseRows(text)[0] });
}

// --- 4. winner/outcome distribution (index1) ---
{
	const { status, text } = await sql(
		"SELECT index1 AS idx, count() AS n FROM RACE_STATS WHERE timestamp > NOW() - INTERVAL '168' HOUR GROUP BY idx ORDER BY n DESC",
	);
	report("index1 distribution 7d", status === 200, {
		status,
		rows: parseRows(text),
	});
}

// --- 5. raw blob1 samples (provider:kind:ms only — no user data) ---
{
	const { status, text } = await sql(
		"SELECT blob1 FROM RACE_STATS WHERE timestamp > NOW() - INTERVAL '24' HOUR LIMIT 3",
	);
	report("blob1 samples", status === 200, { status, rows: parseRows(text) });
}

// --- 6. needle syntax + conditional aggregates ---
{
	const { status, text } = await sql(
		`SELECT
			countIf(position('shim:found:' IN blob1) > 0) AS shimFoundRows,
			sumIf(_sample_interval, position('shim:found:' IN blob1) > 0) AS shimFoundWeighted,
			sumIf(_sample_interval, position('haatz:' IN blob1) > 0) AS haatzRaced,
			sumIf(_sample_interval, position('farcaster-tv:' IN blob1) > 0) AS ftvRaced
		FROM RACE_STATS WHERE timestamp > NOW() - INTERVAL '168' HOUR`,
	);
	report("position needles + countIf/sumIf", status === 200, {
		status,
		row: parseRows(text)[0],
		body: status === 200 ? undefined : preview(text),
	});
}

// --- 7. weighted quantiles on double1 (total elapsed ms) ---
{
	const { status, text } = await sql(
		`SELECT
			quantileExactWeighted(0.5)(double1, _sample_interval) AS p50,
			quantileExactWeighted(0.95)(double1, _sample_interval) AS p95
		FROM RACE_STATS WHERE timestamp > NOW() - INTERVAL '168' HOUR`,
	);
	report("quantileExactWeighted p50/p95", status === 200, {
		status,
		row: parseRows(text)[0],
		body: status === 200 ? undefined : preview(text),
	});
}

// --- 8. per-provider ms extraction (script-generated substring/position pipeline) ---
// The type-conversion function name is a dialect bet — try variants until one parses.
// concat() is absent from the dialect ("unknown function call: CONCAT") —
// two concat-free tails (format() appends; if() guards the last field),
// each × numeric-conversion variants.
type Builder = (provider: string, conv: string) => string;
const buildFormat: Builder = (provider, conv) => {
	const prefix = `${provider}:`;
	const s = `substring(blob1, position('${prefix}' IN blob1) + ${prefix.length})`;
	const t = `substring(${s}, position(':' IN ${s}) + 1)`;
	const tc = `format('{},', ${t})`;
	return `${conv}(substring(${tc}, 1, position(',' IN ${tc}) - 1))`;
};
const buildIf: Builder = (provider, conv) => {
	const prefix = `${provider}:`;
	const s = `substring(blob1, position('${prefix}' IN blob1) + ${prefix.length})`;
	const t = `substring(${s}, position(':' IN ${s}) + 1)`;
	return `${conv}(substring(${t}, 1, if(position(',' IN ${t}) = 0, length(${t}), position(',' IN ${t}) - 1)))`;
};
{
	let winner: { label: string; build: Builder; conv: string } | undefined;
	outer: for (const [build, label] of [
		[buildFormat, "format"] as const,
		[buildIf, "if"] as const,
	]) {
		for (const conv of ["toUInt32", "toUInt8"]) {
			const { status, text } = await sql(
				`SELECT
					quantileExactWeighted(0.5)(${build("shim", conv)}, _sample_interval) AS shimP50,
					quantileExactWeighted(0.95)(${build("shim", conv)}, _sample_interval) AS shimP95,
					sum(_sample_interval) AS shimSamples
				FROM RACE_STATS WHERE timestamp > NOW() - INTERVAL '168' HOUR AND position('shim:' IN blob1) > 0`,
			);
			const row = parseRows(text)[0] ?? {};
			const ok =
				status === 200 &&
				row.nonJsonBody === undefined &&
				row.shimP50 !== undefined;
			report(`shim ms extraction (${label}+${conv})`, ok, { status, row });
			if (ok) {
				winner = { label, build, conv };
				break outer;
			}
		}
	}
	if (winner === undefined) {
		console.log("no ms-extraction variant worked");
	} else {
		const { status, text } = await sql(
			`SELECT
				quantileExactWeighted(0.5)(${winner.build("farcaster-tv", winner.conv)}, _sample_interval) AS ftvP50,
				sum(_sample_interval) AS ftvSamples
			FROM RACE_STATS WHERE timestamp > NOW() - INTERVAL '168' HOUR AND position('farcaster-tv:' IN blob1) > 0`,
		);
		const row = parseRows(text)[0] ?? {};
		report(
			`farcaster-tv ms extraction (${winner.label}+${winner.conv})`,
			status === 200 && row.nonJsonBody === undefined,
			{ status, row },
		);
	}
}

// --- 9. blob1 cardinality (the GraphQL-truncation rationale, empirically) ---
{
	const { status, text } = await sql(
		"SELECT count(DISTINCT blob1) AS distinctBlob1, count() AS n FROM RACE_STATS WHERE timestamp > NOW() - INTERVAL '24' HOUR",
	);
	report("blob1 cardinality 24h", status === 200, {
		status,
		row: parseRows(text)[0],
	});
}

// --- 10. response format (default vs FORMAT JSON) ---
{
	const def = await sql(
		"SELECT count() AS n FROM RACE_STATS WHERE timestamp > NOW() - INTERVAL '1' HOUR",
	);
	const fmt = await sql(
		"SELECT count() AS n FROM RACE_STATS WHERE timestamp > NOW() - INTERVAL '1' HOUR FORMAT JSON",
	);
	console.log(`default format body: ${preview(def.text, 200)}`);
	console.log(`FORMAT JSON body:    ${preview(fmt.text, 200)}`);
}
