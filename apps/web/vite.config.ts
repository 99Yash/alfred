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
        // Carve heavy, rarely-changing vendors out of the always-loaded entry
        // chunk into stable buckets. Without this, react + router + query +
        // replicache + auth all land in one ~580KB entry that every route
        // (including the public landing) pays for on first paint. Splitting
        // them keeps each below the 500KB warning and lets the browser cache
        // vendor code across app deploys.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return "react-vendor";
          }
          if (id.includes("@tanstack")) return "tanstack";
          if (id.includes("replicache")) return "replicache";
          if (id.includes("better-auth") || id.includes("better-call")) {
            return "auth";
          }
        },
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
