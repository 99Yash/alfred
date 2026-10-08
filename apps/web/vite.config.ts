import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [TanStackRouterVite({ autoCodeSplitting: true }), react()],
  build: {
    rollupOptions: {
      output: {
        // Merge tiny shared chunks (lucide icons) into importers, so pages do not load ~20 of them.
        experimentalMinChunkSize: 20_000,
        // Split stable vendors out of the entry chunk, so it stays under 500KB
        // and the browser caches vendor code across deploys.
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
    // Never move onto the API port 3001. That breaks auth with misleading CORS errors.
    strictPort: true,
    proxy: {
      "/api/auth": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
