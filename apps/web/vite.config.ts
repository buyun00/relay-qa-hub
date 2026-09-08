import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import type { Plugin, ProxyOptions } from "vite";
import packageJson from "./package.json" with { type: "json" };

const configuredApi = process.env.QA_HUB_API_BASE_URL?.trim();
const configuredPort = Number(process.env.QA_HUB_WEB_PORT ?? 4274);
if (
  !Number.isSafeInteger(configuredPort) ||
  configuredPort < 1024 ||
  configuredPort > 65535 ||
  [4174, 4319, 4320].includes(configuredPort)
)
  throw new Error("PREVIEW_WEB_PORT_INVALID");
if (configuredApi) {
  const target = new URL(configuredApi);
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password ||
    ["4319", "4174", "4320"].includes(target.port)
  )
    throw new Error("PREVIEW_API_TARGET_INVALID");
}
const requireExplicitService: Plugin = {
  name: "qa-hub-explicit-preview-service",
  configureServer() {
    if (!configuredApi)
      throw new Error("QA_HUB_API_BASE_URL is required for the preview development server");
  },
  configurePreviewServer() {
    if (!configuredApi) throw new Error("QA_HUB_API_BASE_URL is required for the preview server");
  },
};
const proxy: Record<string, string | ProxyOptions> = configuredApi
  ? { "/api": { target: configuredApi, changeOrigin: true, ws: true } }
  : {};
export default defineConfig({
  plugins: [requireExplicitService, react()],
  resolve: { dedupe: ["react", "react-dom"] },
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __CONTRACT_VERSION__: JSON.stringify("1.1.0"),
  },
  build: { target: "es2022", sourcemap: true },
  server: {
    host: process.env.QA_HUB_WEB_HOST ?? "127.0.0.1",
    port: configuredPort,
    strictPort: true,
    proxy,
  },
  preview: {
    host: process.env.QA_HUB_WEB_HOST ?? "127.0.0.1",
    port: configuredPort,
    strictPort: true,
    proxy,
  },
  test: {
    environment: "node",
    server: { deps: { inline: ["qrcode.react"] } },
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
