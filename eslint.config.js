// Audit MEDIUM #12: the repo had no ESLint/Prettier at all — tsc catches
// type errors but not unused vars, unreachable code, missing awaits on
// promises ("no-floating-promises" territory), or style drift. This is a
// deliberately pragmatic first pass, not a rewrite: rules that would fire
// hundreds of times across the existing codebase are set to "warn" so CI can
// start enforcing lint today without a giant unrelated diff; a handful of
// genuinely dangerous patterns (assigning to a const, `==` instead of `===`,
// unreachable code, duplicate keys) are "error" because tripping them is
// always a bug, never a style choice, and there were zero pre-existing
// violations to grandfather in. Tighten (warn -> error, or type-checked
// rules) incrementally in follow-up PRs rather than all at once.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "build/**", "node_modules/**", ".vite/**", "attached_assets/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain-JS service worker: runs in the ServiceWorkerGlobalScope, not
    // Node or a regular window — needs its own global set (self, caches,
    // clients) rather than tsconfig's node/browser globals.
    files: ["client/public/sw.js"],
    languageOptions: {
      globals: { ...globals.serviceworker },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // react-hooks v7 ships the full React Compiler rule set (refs,
      // purity, immutability, set-state-in-effect, ...) as "error". Those
      // check compiler-memoization assumptions this codebase was never
      // written against and fire 40+ times on existing, working components.
      // Take every recommended rule as "warn" except the one with zero
      // pre-existing violations and no false-positive history:
      // rules-of-hooks (calling hooks conditionally/out of order) is a
      // real, unambiguous bug whenever it fires.
      ...Object.fromEntries(
        Object.entries(reactHooks.configs.recommended.rules).map(([rule]) => [rule, "warn"]),
      ),
      "react-hooks/rules-of-hooks": "error",

      // Real bugs, not style — zero pre-existing violations, kept as errors.
      "no-const-assign": "error",
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      eqeqeq: ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",

      // Noisy on this codebase today (52+ `catch (err: any)`, demo/script
      // files, etc.) — real signal, but "warn" so CI goes green without a
      // drive-by rewrite of unrelated files. See audit MEDIUM #11 for the
      // dedicated `: any` cleanup in the payments/auth hot path.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-empty": "warn",
      "no-case-declarations": "warn",

      // Covered by tsc's own resolution/parsing; TS syntax (generics,
      // `interface`, `as const`) trips the base JS parser's own checks.
      "no-undef": "off",
      "no-unused-vars": "off",
    },
  },
  eslintConfigPrettier,
);
