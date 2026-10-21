import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [react()],
  optimizeDeps: { entries: ["tests/ambientGlow.browser.html"] },
  server: {
    host: "127.0.0.1", port: 4187, strictPort: true,
    fs: { allow: [fileURLToPath(new URL("../", import.meta.url))] },
  },
});
