import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["coverage/**", "dist/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict.map((configuration) => ({
    ...configuration,
    files: ["src/**/*.{ts,tsx}", "vite.config.ts"],
    languageOptions: {
      ...configuration.languageOptions,
      parserOptions: {
        ...configuration.languageOptions?.parserOptions,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  })),
  {
    files: ["src/**/*.{ts,tsx}", "vite.config.ts"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/rules-of-hooks": "error",
    },
  },
);
