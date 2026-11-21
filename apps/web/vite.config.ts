import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  // Production builds strip console and debugger statements; dev keeps them.
  esbuild: mode === "production" ? { drop: ["console", "debugger"] } : {},
  plugins: [tanstackRouter({ autoCodeSplitting: true }), react()],
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

          if (id.includes("@tanstack")) {
            // react-form is only used by lazy form consumers (integration
            // forms, styleguide), which import `~/components/ui/v2/form`
            // directly. Excluding it here keeps it out of the eager tanstack
            // vendor chunk; rollup places it with the lazy routes instead.
            if (id.includes("@tanstack/react-form")) return;

            return "tanstack";
          }

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
}));
