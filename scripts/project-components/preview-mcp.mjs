import { createServer, request as proxyRequest } from "node:http";

export async function startPreviewMcp(config) {
  const server = createServer((request, response) => {
    if (request.url !== "/mcp" && request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    const upstream = proxyRequest(
      {
        host: config.apiHost,
        port: config.apiPort,
        method: request.method,
        path: request.url === "/health" ? "/api/v1/health/ready" : "/mcp",
        headers: { ...request.headers, host: `${config.apiHost}:${config.apiPort}` },
      },
      (incoming) => {
        response.writeHead(incoming.statusCode, {
          ...incoming.headers,
          "x-qa-hub-instance": config.instanceId,
        });
        incoming.pipe(response);
      },
    );
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "PREVIEW_API_UNAVAILABLE" }));
    });
    request.pipe(upstream);
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(config.mcpPort, config.mcpHost, accept);
  });
  console.log(
    JSON.stringify({
      event: "preview-mcp.started",
      instanceId: config.instanceId,
      address:
        config.deploymentMode === "lan"
          ? `${new URL(config.publicWebBaseUrl).protocol}//${new URL(config.publicWebBaseUrl).hostname}:${config.mcpPort}/mcp`
          : `http://${config.mcpHost}:${config.mcpPort}/mcp`,
      authentication: "project session Bearer token",
    }),
  );
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close());
  return server;
}
