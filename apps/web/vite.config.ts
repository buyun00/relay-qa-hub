import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

import packageJson from "./package.json" with { type: "json" };

const contractVersion = "1.0.0";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      injectRegister: null,
      includeAssets: [
        "icons/qa-hub-192.svg",
        "icons/qa-hub-512.svg",
        "icons/qa-hub-maskable-512.svg",
      ],
      manifest: {
        id: "/qa-hub",
        name: "Relay QA Hub",
        short_name: "QA Hub",
        description: "Independent QA source of truth. Relay is an optional repair executor.",
        lang: "zh-CN",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#f4f1e8",
        theme_color: "#123b3a",
        icons: [
          {
            src: "/icons/qa-hub-192.svg",
            sizes: "192x192",
            type: "image/svg+xml",
            purpose: "any",
          },
          {
            src: "/icons/qa-hub-512.svg",
            sizes: "512x512",
            type: "image/svg+xml",
            purpose: "any",
          },
          {
            src: "/icons/qa-hub-maskable-512.svg",
            sizes: "512x512",
            type: "image/svg+xml",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: false,
        globPatterns: ["**/*.{js,css,html,webmanifest}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [
          /^\/api(?:\/|$)/,
          /^\/attachments(?:\/|$)/,
          /^\/auth(?:\/|$)/,
          /^\/integrations(?:\/|$)/,
          /^\/uploads(?:\/|$)/,
        ],
        runtimeCaching: [],
      },
    }),
  ],
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
