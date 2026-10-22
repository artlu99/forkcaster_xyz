// Secrets set via `wrangler secret put` (locally: `.dev.vars`) never appear
// in generated worker-configuration.d.ts — this ambient declaration merges
// them into Env. Never hand-edit the generated file.
interface Env {
	LMDIS_URL: string;
	LMDIS_REST_TOKEN: string;
}
