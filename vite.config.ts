import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Note: a `@frontend/` path alias used to live here but no source
// files ever imported through it (`rg "@frontend/"` returned zero
// hits). Removed rather than left in as dead config — adding it
// back later is cheap if/when relative-path import noise becomes
// painful enough to justify it.
export default defineConfig({
  root: "src/frontend",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5180,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            if (!proxyReq.getHeader("X-Primer-Dev-User")) {
              proxyReq.setHeader(
                "X-Primer-Dev-User",
                process.env.PRIMER_DEV_USER ?? "dev@localhost",
              );
            }
          });
        },
      },
    },
  },
});
