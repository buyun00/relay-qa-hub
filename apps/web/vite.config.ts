import react from "@vitejs/plugin-react";
import { createReadStream, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Connect, Plugin, ProxyOptions } from "vite";
import { defineConfig } from "vitest/config";

import packageJson from "./package.json" with { type: "json" };
import desktopPackageJson from "../desktop/package.json" with { type: "json" };

const contractVersion = "1.0.0";
const webAuthMode = process.env.QA_HUB_WEB_AUTH_MODE?.trim().toLowerCase() || "session";
if (webAuthMode !== "session" && webAuthMode !== "debug") {
  throw new Error("QA_HUB_WEB_AUTH_MODE must be session or debug");
}
const debugProxyToken = process.env.QA_HUB_MVP_ACCESS_TOKEN?.trim();
const webHost = process.env.QA_HUB_WEB_HOST?.trim() || "127.0.0.1";
const androidApkDownloadPath = "/downloads/Relay-QA-Hub-Android12-debug.apk";
const androidApkFile = fileURLToPath(
  new URL("../android/app/build/outputs/apk/debug/app-debug.apk", import.meta.url),
);
const windowsZipDownloadPath = "/downloads/Relay-QA-Hub-Windows-x64.zip";
const windowsZipFile = fileURLToPath(
  new URL("../desktop/release/RelayQaHub-win32-x64.zip", import.meta.url),
);
const windowsUpdateManifestPath = "/downloads/Relay-QA-Hub-Windows-x64-latest.json";
const windowsUpdateManifestFile = fileURLToPath(
  new URL("../desktop/release/RelayQaHub-win32-x64-latest.json", import.meta.url),
);
const windowsInstallerDownloadPath = "/downloads/Relay-QA-Hub-Setup-x64.exe";
const windowsInstallerFile = fileURLToPath(
  new URL("../desktop/release/installer/Relay-QA-Hub-Setup-x64.exe", import.meta.url),
);
if (webAuthMode === "debug" && !debugProxyToken) {
  throw new Error("QA_HUB_MVP_ACCESS_TOKEN is required in debug Web auth mode");
}

function createApiProxy(): Record<string, ProxyOptions> {
  return {
    "/api": {
      target: process.env.QA_HUB_API_BASE_URL ?? "http://127.0.0.1:4319",
      changeOrigin: true,
      configure(proxy) {
        proxy.on("proxyReq", (proxyRequest) => {
          if (webAuthMode === "session") return;
          proxyRequest.setHeader("authorization", `Bearer ${debugProxyToken}`);
        });
      },
    },
  };
}

interface DownloadableArtifact {
  readonly file: string;
  readonly contentType: string;
  readonly fileName: string;
  readonly missingMessage: string;
  readonly attachment?: boolean;
}

const downloadableArtifacts: ReadonlyMap<string, DownloadableArtifact> = new Map([
  [
    androidApkDownloadPath,
    {
      file: androidApkFile,
      contentType: "application/vnd.android.package-archive",
      fileName: "Relay-QA-Hub-Android12-debug.apk",
      missingMessage: "Android APK has not been built yet.",
    },
  ],
  [
    windowsZipDownloadPath,
    {
      file: windowsZipFile,
      contentType: "application/zip",
      fileName: "Relay-QA-Hub-Windows-x64.zip",
      missingMessage: "Windows package has not been built yet.",
    },
  ],
  [
    windowsUpdateManifestPath,
    {
      file: windowsUpdateManifestFile,
      contentType: "application/json; charset=utf-8",
      fileName: "Relay-QA-Hub-Windows-x64-latest.json",
      missingMessage: "Windows update manifest has not been published yet.",
      attachment: false,
    },
  ],
  [
    windowsInstallerDownloadPath,
    {
      file: windowsInstallerFile,
      contentType: "application/vnd.microsoft.portable-executable",
      fileName: `Relay-QA-Hub-Setup-${desktopPackageJson.version}-x64.exe`,
      missingMessage: "Windows installer has not been published yet.",
    },
  ],
]);

function artifactDownloadPlugin(): Plugin {
  const attachDownloadRoute = (middlewares: Connect.Server): void => {
    middlewares.use((request, response, next) => {
      const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const artifact = downloadableArtifacts.get(requestPath);
      if (artifact === undefined) return next();
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.statusCode = 405;
        response.setHeader("allow", "GET, HEAD");
        response.end();
        return;
      }

      let size: number;
      try {
        size = statSync(artifact.file).size;
      } catch {
        response.statusCode = 404;
        response.end(artifact.missingMessage);
        return;
      }

      response.statusCode = 200;
      response.setHeader("content-type", artifact.contentType);
      if (artifact.attachment !== false) {
        response.setHeader("content-disposition", `attachment; filename="${artifact.fileName}"`);
      }
      response.setHeader("content-length", size.toString());
      response.setHeader("cache-control", "no-store");
      response.setHeader("x-content-type-options", "nosniff");
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      createReadStream(artifact.file).pipe(response);
    });
  };
  return {
    name: "relay-qa-hub-artifact-downloads",
    configureServer(server) {
      attachDownloadRoute(server.middlewares);
    },
    configurePreviewServer(server) {
      attachDownloadRoute(server.middlewares);
    },
  };
}

export default defineConfig({
  plugins: [artifactDownloadPlugin(), react()],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __CONTRACT_VERSION__: JSON.stringify(contractVersion),
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  server: {
    host: webHost,
    port: 4174,
    strictPort: true,
    proxy: createApiProxy(),
  },
  preview: {
    host: webHost,
    port: 4174,
    strictPort: true,
    proxy: createApiProxy(),
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
