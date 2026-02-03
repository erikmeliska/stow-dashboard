import nextPlugin from "@next/eslint-plugin-next";
import reactPlugin from "eslint-plugin-react";
import hooksPlugin from "eslint-plugin-react-hooks";
import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    files: ["**/*.{js,jsx,mjs}"],
    plugins: {
      "@next/next": nextPlugin,
      "react": reactPlugin,
      "react-hooks": hooksPlugin,
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        React: "readonly",
        console: "readonly",
        document: "readonly",
        window: "readonly",
        navigator: "readonly",
        fetch: "readonly",
        localStorage: "readonly",
        process: "readonly",
        module: "readonly",
        require: "readonly",
        __dirname: "readonly",
        URL: "readonly",
      },
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
    settings: {
      react: {
        version: "detect",
      },
    },
  },
  {
    ignores: [".next/**", ".next-build/**", "node_modules/**"],
  },
];
