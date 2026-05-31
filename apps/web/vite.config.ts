import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [TanStackRouterVite({ autoCodeSplitting: true }), react()],
  build: {
    rollupOptions: {
      output: {
        // Shared lucide icons (and other tiny shared modules) otherwise each
        // become their own ~1KB chunk — the landing page alone pulled ~20 of
        // them as separate requests. Merge sub-20KB chunks into their importers
        // to collapse that waterfall.
        experimentalMinChunkSize: 20_000,
      },
    },
  },
  resolve: {
    alias: {
      "~": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    port: 3000,
    proxy: {
      "/api/auth": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
