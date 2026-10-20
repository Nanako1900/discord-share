import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			// Routing glue that only runs inside workerd; verified end-to-end with `wrangler dev`.
			exclude: ["src/index.ts"],
			thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
		},
	},
});
