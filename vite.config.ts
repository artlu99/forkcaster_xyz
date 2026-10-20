import path from "node:path";
import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));

// https://vite.dev/config/
export default defineConfig({
	plugins: [preact(), cloudflare()],
	resolve: {
		alias: {
			react: "preact/compat",
			"react-dom": "preact/compat",
			"react/jsx-runtime": "preact/jsx-runtime",
			"react/jsx-dev-runtime": "preact/jsx-dev-runtime",
			"server-only": path.join(root, "worker/shims/server-only.ts"),
		},
	},
});
