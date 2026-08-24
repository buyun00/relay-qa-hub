import { createApiServer } from "./server.js";
import { DEFAULT_API_HOST, resolvePort } from "./config.js";

const configuredBuildSha = process.env["QA_HUB_BUILD_SHA"];
const server = createApiServer(
  configuredBuildSha === undefined ? {} : { buildSha: configuredBuildSha },
);

let shutdownStarted = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;

  server.app.log.info({ signal }, "stopping Relay QA Hub API");

  try {
    await server.stop();
    process.exitCode = 0;
  } catch (error: unknown) {
    server.app.log.error({ error, signal }, "failed to stop Relay QA Hub API");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

try {
  const address = await server.start({
    host: process.env["QA_HUB_API_HOST"] ?? DEFAULT_API_HOST,
    port: resolvePort(process.env["QA_HUB_API_PORT"]),
  });
  server.app.log.info({ address }, "Relay QA Hub API started");
} catch (error: unknown) {
  server.app.log.error({ error }, "Relay QA Hub API failed to start");
  process.exitCode = 1;
  await server.stop();
}
