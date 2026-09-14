// ESLint Flat Config for pi-gateway
// Uses @typescript-eslint parser & plugin, and disables style conflicts via eslint-config-prettier.
import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		// Apply recommended JS rules to all files
		...js.configs.recommended,
	},
	...tseslint.configs.recommended,
	{
		ignores: ["dist/**", "node_modules/**", "tests/**", "output/**"],
	},
	{
		files: ["src/**/*.ts", "config/**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				ecmaVersion: 2022,
				sourceType: "module",
			},
		},
		rules: {
			// Turn off style rules that conflict with Prettier
			...prettier.rules,
			// Allow intentionally-unused parameters whose names start with `_`
			// (required to satisfy interface/abstract method signatures).
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					ignoreRestSiblings: true,
				},
			],
		},
	},
);
