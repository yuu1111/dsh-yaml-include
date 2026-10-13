import { library } from "@yuu1111/knip-config/library";

export default {
	...library,
	/**
	 * Includes runtime-loaded configuration and executable roots that imports cannot infer.
	 */
	entry: [
		"quality.json",
		"src/install.ts",
		"scripts/smoke.ts",
		"tests/*.test.ts",
	],

	/**
	 * Checks authored code without treating generated distributions as separate sources.
	 */
	project: ["src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"],
};
