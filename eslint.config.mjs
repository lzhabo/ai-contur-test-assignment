import { builtinModules } from "node:module";
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", ".local-data/**", "node_modules/**"] },
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["src/client/**/*.{ts,tsx}", "src/shared/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "process", message: "Настройки Node.js остаются на сервере." },
        { name: "Buffer", message: "Клиент использует браузерные API." },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: builtinModules,
          patterns: [
            {
              group: ["**/server/**", "node:*", "@langchain/**", "quickjs-emscripten"],
              message: "Клиент и общие API-типы не зависят от серверной реализации.",
            },
          ],
        },
      ],
    },
  },
);
