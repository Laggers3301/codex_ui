import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: { entries: ["tests/threadActivity.browser.html"] },
  server: { host: "127.0.0.1", port: 5174, strictPort: true, proxy: { "/api": "http://127.0.0.1:4575", "/ws": { target: "ws://127.0.0.1:4575", ws: true } } }
});
