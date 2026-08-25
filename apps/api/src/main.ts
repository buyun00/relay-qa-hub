import {
  parseStorageEnvironment,
  SqliteStorageWorker,
  type MobileScopeBootstrap,
} from "@relay-qa-hub/storage";

import { DEFAULT_API_HOST, resolvePort } from "./config.js";
import { createApiServer, type ApiServer } from "./server.js";
import { createSqliteMobileAttachmentStore } from "./sqlite-mobile-attachment-store.js";
import { createSqliteMobileBugStore } from "./sqlite-mobile-bug-store.js";

const MOBILE_SCOPE: MobileScopeBootstrap = Object.freeze({
  accountId: "10000000-0000-4000-8000-000000000020",
  projectId: "10000000-0000-4000-8000-000000000004",
  actorId: "10000000-0000-4000-8000-000000000003",
  membershipId: "10000000-0000-4000-8000-000000000005",
  projectKey: "LOCAL",
  createdAt: "2026-08-25T00:00:00.000Z",
});

function requireMobileAccessToken(): string {
  const token = process.env["QA_HUB_MVP_ACCESS_TOKEN"]?.trim();
  if (!token) throw new Error("QA_HUB_MVP_ACCESS_TOKEN is required");
  return token;
}

async function closeRuntime(
  server: ApiServer | undefined,
  worker: SqliteStorageWorker,
): Promise<void> {
  await server?.stop();
  await worker.close();
}

async function run(): Promise<void> {
  const storage = parseStorageEnvironment(process.env);
  const debugBearerToken = requireMobileAccessToken();
  const worker = new SqliteStorageWorker({
    databaseFile: storage.databaseFile,
    busyTimeoutMs: storage.busyTimeoutMs,
    evidenceRoot: storage.evidenceRoot,
    quarantineRoot: storage.quarantineRoot,
  });
  let server: ApiServer | undefined;
  let shutdownStarted = false;

  try {
    await worker.ensureMobileScope(MOBILE_SCOPE);
    const configuredBuildSha = process.env["QA_HUB_BUILD_SHA"];
    server = createApiServer({
      ...(configuredBuildSha === undefined ? {} : { buildSha: configuredBuildSha }),
      mobileBugStore: createSqliteMobileBugStore({ worker, scope: MOBILE_SCOPE }),
      mobileAttachmentStore: createSqliteMobileAttachmentStore({ worker, scope: MOBILE_SCOPE }),
      debugBearerToken,
      debugActorId: MOBILE_SCOPE.actorId,
    });

    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
      if (shutdownStarted) return;
      shutdownStarted = true;
      server?.app.log.info({ signal }, "stopping Relay QA Hub API");
      try {
        await closeRuntime(server, worker);
        process.exitCode = 0;
      } catch (error: unknown) {
        server?.app.log.error({ error, signal }, "failed to stop Relay QA Hub API");
        process.exitCode = 1;
      }
    };

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));

    const address = await server.start({
      host: process.env["QA_HUB_API_HOST"] ?? DEFAULT_API_HOST,
      port: resolvePort(process.env["QA_HUB_API_PORT"]),
    });
    server.app.log.info(
      { address, databaseFile: storage.databaseFile },
      "Relay QA Hub API started",
    );
  } catch (error: unknown) {
    if (server) {
      server.app.log.error({ error }, "Relay QA Hub API failed to start");
    } else {
      console.error("Relay QA Hub API failed to initialize", error);
    }
    process.exitCode = 1;
    await closeRuntime(server, worker).catch(() => undefined);
  }
}

await run();
