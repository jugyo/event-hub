import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "node_modules/", "coverage/", ".event-hub/"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts}"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "no-constant-condition": ["error", { checkLoops: false }],
      "preserve-caught-error": "off",
    },
  },
);
