import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Contract tests talk to the live local API on :8081; they run only when a
    // fixture is present (the seed script writes it), and skip cleanly otherwise.
    testTimeout: 15000,
  },
});
