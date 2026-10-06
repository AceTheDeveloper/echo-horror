const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  js.configs.recommended,
  {
    files: ["index.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser },
    },
    rules: {
      // Functions such as startGame/advanceStory are wired up from the page
      // itself, and empty catch blocks are intentional for storage/audio guards.
      "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["scripts/**/*.js", "test/**/*.js", "eslint.config.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
  },
];
