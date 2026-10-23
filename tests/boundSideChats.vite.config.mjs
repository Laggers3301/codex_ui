import { defineConfig } from "vite";
import base from "../vite.config.ts";

const target = process.env.BOUND_SIDE_CHAT_TEST_BACKEND;
if (!target || !/^http:\/\/127\.0\.0\.1:\d+$/.test(target)) throw new Error("An isolated side-chat test backend is required.");
export default defineConfig({ ...base, server: { ...base.server, host: "127.0.0.1", port: 5212, strictPort: true,
  proxy: { "/api": target, "/ws": { target, ws: true } } } });
