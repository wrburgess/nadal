import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // tools/gate and tools/review are deuce's seeded copies, dormant until the gate is wired —
  // linted then, under the day-one adoption issue that lifts this carve-out.
  { ignores: ["dist/", "node_modules/", "coverage/", "drizzle/", "tools/gate/", "tools/review/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
