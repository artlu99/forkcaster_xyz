// Shim fixed-overhead floor check: time the lightweight /f/{username}
// lookup (Redis-ish fid read, no Snapchain cast query) twice. If even this
// sits at ~300ms+, the floor is network path + service overhead, not cache
// state — which would explain the 341ms minimum settle across 102 races.

const t = async (label: string, url: string): Promise<void> => {
	const started = Date.now();
	const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
	await r.text();
	console.log(`${label}: ${Date.now() - started}ms (HTTP ${r.status})`);
};

await t("/f/artlu #1", "https://shim.artlu.xyz/f/artlu");
await t("/f/artlu #2 (repeat)", "https://shim.artlu.xyz/f/artlu");
await t("/f/artlu #3 (repeat)", "https://shim.artlu.xyz/f/artlu");
