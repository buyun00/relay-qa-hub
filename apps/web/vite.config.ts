import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

import packageJson from "./package.json" with { type: "json" };

const contractVersion = "1.0.0";

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __CONTRACT_VERSION__: JSON.stringify(contractVersion),
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  server: {
    host: "127.0.0.1",
    port: 4174,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.QA_HUB_API_BASE_URL ?? "http://127.0.0.1:4319",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (proxyRequest) => {
            if (process.env.QA_HUB_WEB_AUTH_MODE === "session") return;
            const token = process.env.QA_HUB_MVP_ACCESS_TOKEN?.trim();
            if (token) proxyRequest.setHeader("authorization", `Bearer ${token}`);
          });
        },
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4174,
    strictPort: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
