import { defineConfig } from "vitest/config";

// One config for the three packages: `npm test` at the root runs all of them.
export default defineConfig({
  test: {
    include: [
      "shared/test/**/*.test.js",
      "client/test/**/*.test.js",
      "server/test/**/*.test.js",
    ],
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["shared/src/**/*.ts"],
      reporter: ["text-summary", "text"],
    },
  },
});
