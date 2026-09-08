import { createServer, request as proxyRequest } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join } from "node:path";
import {
  canonicalInstancePath,
  isInstancePathWithin,
} from "../../apps/api/src/parallel-instance.ts";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".apk": "application/vnd.android.package-archive",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".zip": "application/zip",
};
export async function startPreviewWeb(config) {
  const webRoot = canonicalInstancePath(join(config.sourceRoot, "apps/web/dist"));
  statSync(join(webRoot, "index.html"));
  const server = createServer((request, response) => {
    response.setHeader("x-qa-hub-instance", config.instanceId);
    response.setHeader("x-content-type-options", "nosniff");
    const url = new URL(request.url, `http://${config.webHost}:${config.webPort}`);
    if (url.pathname.startsWith("/api/")) {
      const target = proxyRequest(
        {
          host: config.apiHost,
          port: config.apiPort,
          path: request.url,
          method: request.method,
          headers: { ...request.headers, host: `${config.apiHost}:${config.apiPort}` },
        },
        (upstream) => {
          response.writeHead(upstream.statusCode, upstream.headers);
          upstream.pipe(response);
        },
      );
      target.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end(JSON.stringify({ code: "PREVIEW_API_UNAVAILABLE" }));
      });
      request.pipe(target);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    try {
      const download = url.pathname.startsWith("/downloads/");
      const root = download ? config.downloadsRoot : webRoot;
      const relativePath = decodeURIComponent(
        download ? url.pathname.slice("/downloads/".length) : url.pathname.slice(1),
      );
      let file = canonicalInstancePath(join(root, relativePath || "index.html"));
      if (!isInstancePathWithin(file, root)) {
        response.writeHead(403).end();
        return;
      }
      if (!download && !extname(relativePath)) file = join(webRoot, "index.html");
      const info = statSync(file);
      if (!info.isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "content-length": info.size,
        "cache-control": "no-store",
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://${config.webHost}:${config.webPort}`);
    if (url.pathname !== "/api/v1/notifications/stream") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    // Authentication and current membership are checked by the API WebSocket handler.
    const upstream = proxyRequest({
      host: config.apiHost,
      port: config.apiPort,
      path: request.url,
      method: "GET",
      headers: { ...request.headers, host: `${config.apiHost}:${config.apiPort}` },
    });
    upstream.on("upgrade", (response, remote, upstreamHead) => {
      socket.write(
        `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` +
          Array.from(
            { length: response.rawHeaders.length / 2 },
            (_, index) =>
              `${response.rawHeaders[index * 2]}: ${response.rawHeaders[index * 2 + 1]}`,
          ).join("\r\n") +
          "\r\n\r\n",
      );
      if (head.length) remote.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      socket.on("error", () => remote.destroy());
      remote.on("error", () => socket.destroy());
      socket.on("close", () => remote.destroy());
      remote.on("close", () => socket.destroy());
      socket.pipe(remote);
      remote.pipe(socket);
    });
    upstream.on("response", (response) => {
      socket.end(
        `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`,
      );
      response.resume();
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.end();
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(config.webPort, config.webHost, accept);
  });
  console.log(
    JSON.stringify({
      event: "preview-web.started",
      instanceId: config.instanceId,
      address: `http://${config.webHost}:${config.webPort}`,
      sourceRoot: config.sourceRoot,
      downloadsRoot: config.downloadsRoot,
    }),
  );
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
  return server;
}
