// Phase 0 probe — lmdis (scripts/probe/lmdis.ts)
// Validates the plan's lmdis assumptions against the live store.
// Prints statuses and response shapes only — never token values.
//
// Run: dotenvx run -- bun scripts/probe/lmdis.ts

const url = (process.env.LMDIS_URL ?? "").replace(/\/+$/, "");
const token = process.env.LMDIS_REST_TOKEN ?? "";
if (url === "" || token === "") {
	console.error(
		"missing LMDIS_URL / LMDIS_REST_TOKEN — load via dotenvx (see .env.example)",
	);
	process.exit(1);
}

type Body = { result?: unknown; error?: string; code?: string };

async function command(
	cmd: unknown[],
	auth: string = token,
): Promise<{ status: number; body: Body }> {
	const res = await fetch(`${url}/`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${auth}`,
		},
		body: JSON.stringify(cmd),
		signal: AbortSignal.timeout(5000),
	});
	const body = (await res.json().catch(() => ({}))) as Body;
	return { status: res.status, body };
}

function report(name: string, ok: boolean, detail?: unknown): void {
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`,
	);
}

// 1. health (public, no auth)
{
	const res = await fetch(`${url}/health`, {
		signal: AbortSignal.timeout(5000),
	});
	const body = (await res.json().catch(() => ({}))) as { status?: string };
	report("GET /health", res.ok && body.status === "ok", {
		status: res.status,
		body,
	});
}

// 2. wrong token → 401 UNAUTHORIZED shape (the shape we degrade against)
{
	const { status, body } = await command(["GET", "race-stats"], "bogus-token");
	report(
		"wrong token → 401 UNAUTHORIZED",
		status === 401 &&
			body.code === "UNAUTHORIZED" &&
			typeof body.error === "string",
		{ status, body },
	);
}

// 3. SET/GET/DEL roundtrip on a probe key
{
	const key = `race-stats:probe:${Date.now().toString(36)}`;
	const value = JSON.stringify({ probe: true, at: new Date().toISOString() });
	const set = await command(["SET", key, value]);
	const get = await command(["GET", key]);
	report("SET → OK", set.status === 200 && set.body.result === "OK", {
		status: set.status,
		body: set.body,
	});
	report("GET returns the written string", get.body.result === value, {
		status: get.status,
	});
	const del = await command(["DEL", key]);
	const gone = await command(["GET", key]);
	report(
		"DEL removes, GET → null",
		del.body.result === 1 && gone.body.result === null,
		{
			status: del.status,
		},
	);
}

// 4. missing key → {"result":null}
{
	const { status, body } = await command([
		"GET",
		"race-stats:definitely-missing",
	]);
	report("missing key → result null", status === 200 && body.result === null, {
		status,
		body,
	});
}
