import eslintJs from "@eslint/js";

/** @type {import('eslint').Linter.Config[]} */
const config = [
  {
    files: ["public/player/*.js"],
    ...eslintJs.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        document: "readonly",
        window: "readonly",
        console: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        performance: "readonly",
        localStorage: "readonly",
        RTCPeerConnection: "readonly",
        RTCSessionDescription: "readonly",
        MediaStream: "readonly",
        Uint8Array: "readonly",
        URLSearchParams: "readonly",
        crypto: "readonly",
        JSON: "readonly",
        navigator: "readonly",
        AudioContext: "readonly",
        cancelAnimationFrame: "readonly",
        requestAnimationFrame: "readonly",
        location: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];

export default config;
