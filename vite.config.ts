import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const superDocRuntime = fileURLToPath(new URL("./src/writing/SuperDocRuntime.ts", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: [{ find: /^superdoc$/, replacement: superDocRuntime }] },
  build: {
    // Keep old content-hashed bundles available to tabs that loaded before deployment.
    emptyOutDir: false
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4576",
      "/ws": {
        target: "ws://127.0.0.1:4576",
        ws: true
      }
    }
  }
});
