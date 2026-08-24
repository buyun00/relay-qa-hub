import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      ".tools/**",
      "apps/android/**/build/**",
      "apps/android/.gradle/**",
      "apps/android/.kotlin/**",
      "packages/contracts/openapi/**",
    ],
  },
  {
    ...eslint.configs.recommended,
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ...eslint.configs.recommended.languageOptions,
      globals: globals.node,
      sourceType: "module",
    },
  },
  ...tseslint.configs.recommended.map((configuration) => ({
    ...configuration,
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ...configuration.languageOptions,
      parserOptions: {
        ...configuration.languageOptions?.parserOptions,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  })),
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
      },
    },
  },
  {
    files: ["**/*.{ts,tsx,js,mjs}"],
    rules: {
      "no-console": "off",
    },
  },
);
