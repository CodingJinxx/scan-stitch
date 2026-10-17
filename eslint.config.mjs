import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  { ignores: ["node_modules/**", "main.js", "*.mjs", "scripts/**", ".superpowers/**", "docs/**"] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // moment is a dev-only type peer required by the obsidian typings.
    files: ["package.json"],
    rules: { "depend/ban-dependencies": "off" },
  },
]);
