import js from "@eslint/js";
import globals from "globals";

export default [
  // site/ enthält die übernommenen Theme-/Plugin-Skripte von WordPress, die prüfen wir nicht
  { ignores: ["dist/", "site/", "var/"] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
  },
];
