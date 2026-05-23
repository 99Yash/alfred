import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/actions.ts", "src/agent.ts", "src/events.ts"],
  dts: true,
  sourcemap: true,
  format: ["esm"],
  clean: true,
});
