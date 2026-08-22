import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    // Keep old content-hashed bundles available to tabs that loaded before deployment.
    emptyOutDir: false
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4573",
      "/ws": {
        target: "ws://127.0.0.1:4573",
        ws: true
      }
    }
  }
});
