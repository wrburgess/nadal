import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**", "tools/**"],
      thresholds: { lines: 75, functions: 75 },
    },
  },
});
