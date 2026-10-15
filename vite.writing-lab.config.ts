import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const superDocRuntime = fileURLToPath(new URL("./src/writing/SuperDocRuntime.ts", import.meta.url));

// Preserve production chat APIs; only document APIs use the independent lab.
export default defineConfig({ plugins: [react()], resolve: { alias: [{ find: /^superdoc$/, replacement: superDocRuntime }] }, build: { outDir: "dist-writing-lab", emptyOutDir: false, rollupOptions: { maxParallelFileOps: 32 } },
  server: { host: "0.0.0.0", port: 4590, strictPort: true, proxy: {
    "^/api/projects/[^/]+/documents": "http://127.0.0.1:4591",
    "/api/documents": "http://127.0.0.1:4591", "/api": "http://127.0.0.1:4576",
    "/login": "http://127.0.0.1:4576", "/ws": { target: "ws://127.0.0.1:4576", ws: true }
  } }
});
