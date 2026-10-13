import { library } from "@yuu1111/knip-config/library";

export default {
	...library,
	entry: [
		"quality.json",
		"src/install.ts",
		"scripts/smoke.ts",
		"tests/*.test.ts",
	],
	project: ["src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"],
};
