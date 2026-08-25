import { join } from "node:path";

import {
  parseStorageEnvironment,
  SqliteStorageWorker,
  type MobileScopeBootstrap,
} from "@relay-qa-hub/storage";

import {
  createApiBackupRunner,
  parseApiBackupEnvironment,
  type ApiBackupRunner,
} from "./backup-runner.js";
import { DEFAULT_API_HOST, resolvePort } from "./config.js";
import { createApiServer, type ApiServer } from "./server.js";
import { createSqliteApiHealthProbe } from "./health.js";
import { createSqliteMobileAttachmentStore } from "./sqlite-mobile-attachment-store.js";
import { createSqliteMobileBuildStore } from "./sqlite-mobile-build-store.js";
import { createSqliteMobileDuplicateStore } from "./sqlite-mobile-duplicate-store.js";
import { createSqliteMobileInboxStore } from "./sqlite-mobile-inbox-store.js";
import { createSqliteMobileProjectDirectoryStore } from "./sqlite-mobile-project-directory-store.js";
import { createSqliteMobileBugStore } from "./sqlite-mobile-bug-store.js";
import { createSqliteMobileCaptureStore } from "./sqlite-mobile-capture-store.js";
import { createSqliteMobileRelayStore } from "./sqlite-mobile-relay-store.js";
import { createSqliteMobileRelayWebhookStore } from "./sqlite-mobile-relay-webhook-store.js";
import { createSqliteMobileVerificationStore } from "./sqlite-mobile-verification-store.js";
import { createSqliteMobileHumanWorkflowStore } from "./sqlite-mobile-human-workflow-store.js";
import { createSqliteMobileCommentStore } from "./sqlite-mobile-comment-store.js";
import { createSqliteMobileMetricsStore } from "./sqlite-mobile-metrics-store.js";
import { createSqliteBrowserAuthStore } from "./browser-auth.js";
import {
  parseFakeRelayEndpoint,
  startMobileRelayOutboxPump,
  type MobileRelayOutboxPump,
} from "./mobile-relay-outbox.js";

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

function readRelayWebhookSecret(fakeRelayEndpoint: URL | undefined): string | undefined {
  const configured = process.env["QA_HUB_RELAY_WEBHOOK_SECRET"]?.trim();
  if (configured !== undefined && configured.length < 32) {
    throw new Error("QA_HUB_RELAY_WEBHOOK_SECRET must contain at least 32 characters");
  }
  if (fakeRelayEndpoint !== undefined && configured === undefined) {
    throw new Error("QA_HUB_RELAY_WEBHOOK_SECRET is required with QA_HUB_FAKE_RELAY_URL");
  }
  return configured;
}

function readWebSessionSecret(): string | undefined {
  const configured = process.env["QA_HUB_WEB_SESSION_SECRET"]?.trim();
  if (configured === undefined || configured.length === 0) return undefined;
  if (configured.length < 32) {
    throw new Error("QA_HUB_WEB_SESSION_SECRET must contain at least 32 characters");
  }
  return configured;
}

function readSecureCookie(): boolean | undefined {
  const value = process.env["QA_HUB_WEB_SECURE_COOKIE"]?.trim().toLowerCase();
  if (value === undefined) return undefined;
  if (value === "false") return false;
  if (value === "true") return true;
  throw new Error("QA_HUB_WEB_SECURE_COOKIE must be true or false");
}

function readNotificationHintChannelEnabled(): boolean {
  const value = process.env["QA_HUB_NOTIFICATION_HINT_CHANNEL_ENABLED"]?.trim().toLowerCase();
  if (value === undefined || value === "true") return true;
  if (value === "false") return false;
  throw new Error("QA_HUB_NOTIFICATION_HINT_CHANNEL_ENABLED must be true or false");
}

async function closeRuntime(
  server: ApiServer | undefined,
  worker: SqliteStorageWorker,
  relayPump: MobileRelayOutboxPump | undefined,
  backupRunner: ApiBackupRunner | undefined,
): Promise<void> {
  await backupRunner?.stop();
  await relayPump?.stop();
  await server?.stop();
  await worker.close();
}

async function run(): Promise<void> {
  const storage = parseStorageEnvironment(process.env);
  const debugBearerToken = requireMobileAccessToken();
  const backupConfig = parseApiBackupEnvironment(process.env, {
    dataRoot: storage.dataRoot,
    databaseFile: storage.databaseFile,
    evidenceRoot: storage.evidenceRoot,
    quarantineRoot: storage.quarantineRoot,
    ...(process.env["QA_HUB_SOURCE_ROOT"] === undefined
      ? {}
      : { sourceRoot: process.env["QA_HUB_SOURCE_ROOT"] }),
  });
  const worker = new SqliteStorageWorker({
    databaseFile: storage.databaseFile,
    busyTimeoutMs: storage.busyTimeoutMs,
    ...(backupConfig.enabled ? { backupRoot: join(backupConfig.backupRoot, "migration") } : {}),
    evidenceRoot: storage.evidenceRoot,
    quarantineRoot: storage.quarantineRoot,
  });
  let server: ApiServer | undefined;
  let relayPump: MobileRelayOutboxPump | undefined;
  let backupRunner: ApiBackupRunner | undefined;
  let shutdownStarted = false;

  try {
    await worker.ensureMobileScope(MOBILE_SCOPE);
    await worker.ensureMobileRelayRoles(MOBILE_SCOPE);
    const webSessionSecret = readWebSessionSecret();
    const secureCookie = readSecureCookie();
    const webBootstrapPassword = process.env["QA_HUB_BOOTSTRAP_ADMIN_PASSWORD"];
    if (webBootstrapPassword !== undefined && webSessionSecret === undefined) {
      throw new Error("QA_HUB_WEB_SESSION_SECRET is required with QA_HUB_BOOTSTRAP_ADMIN_PASSWORD");
    }
    const browserAuthStore =
      webSessionSecret === undefined
        ? undefined
        : createSqliteBrowserAuthStore({
            worker,
          });
    if (browserAuthStore !== undefined && webBootstrapPassword !== undefined) {
      await browserAuthStore.ensureBrowserAdmin({
        accountId: MOBILE_SCOPE.accountId,
        userId: MOBILE_SCOPE.actorId,
        actorId: MOBILE_SCOPE.actorId,
        email: `mvp-${MOBILE_SCOPE.actorId.replaceAll("-", "")}@local.invalid`,
        password: webBootstrapPassword,
        now: new Date().toISOString(),
      });
    }
    const configuredBuildSha = process.env["QA_HUB_BUILD_SHA"];
    const fakeRelayEndpoint = parseFakeRelayEndpoint(process.env["QA_HUB_FAKE_RELAY_URL"]);
    const relayWebhookSecret = readRelayWebhookSecret(fakeRelayEndpoint);
    server = createApiServer({
      ...(configuredBuildSha === undefined ? {} : { buildSha: configuredBuildSha }),
      healthProbe: createSqliteApiHealthProbe({
        worker,
        evidenceRoot: storage.evidenceRoot,
        quarantineRoot: storage.quarantineRoot,
      }),
      mobileBugStore: createSqliteMobileBugStore({ worker, scope: MOBILE_SCOPE }),
      mobileAttachmentStore: createSqliteMobileAttachmentStore({ worker, scope: MOBILE_SCOPE }),
      mobileBuildStore: createSqliteMobileBuildStore({ worker, scope: MOBILE_SCOPE }),
      mobileVerificationStore: createSqliteMobileVerificationStore({ worker, scope: MOBILE_SCOPE }),
      mobileHumanWorkflowStore: createSqliteMobileHumanWorkflowStore({
        worker,
        scope: MOBILE_SCOPE,
      }),
      mobileCommentStore: createSqliteMobileCommentStore({ worker, scope: MOBILE_SCOPE }),
      mobileDuplicateStore: createSqliteMobileDuplicateStore({ worker, scope: MOBILE_SCOPE }),
      mobileNotificationStore: createSqliteMobileInboxStore({ worker, scope: MOBILE_SCOPE }),
      notificationHintChannelEnabled: readNotificationHintChannelEnabled(),
      mobileProjectDirectoryStore: createSqliteMobileProjectDirectoryStore({
        worker,
        scope: MOBILE_SCOPE,
      }),
      mobileMetricsStore: createSqliteMobileMetricsStore({ worker, scope: MOBILE_SCOPE }),
      mobileCaptureStore: createSqliteMobileCaptureStore({ worker, scope: MOBILE_SCOPE }),
      mobileRelayStore: createSqliteMobileRelayStore({ worker, scope: MOBILE_SCOPE }),
      ...(relayWebhookSecret === undefined
        ? {}
        : {
            mobileRelayWebhookStore: createSqliteMobileRelayWebhookStore({
              worker,
              scope: MOBILE_SCOPE,
            }),
            relayWebhookSecret,
          }),
      debugBearerToken,
      debugActorId: MOBILE_SCOPE.actorId,
      ...(browserAuthStore === undefined || webSessionSecret === undefined
        ? {}
        : {
            browserAuth: {
              store: browserAuthStore,
              accountId: MOBILE_SCOPE.accountId,
              userId: MOBILE_SCOPE.actorId,
              actorId: MOBILE_SCOPE.actorId,
              adminEmail: `mvp-${MOBILE_SCOPE.actorId.replaceAll("-", "")}@local.invalid`,
              sessionSecret: webSessionSecret,
              webOrigin: process.env["QA_HUB_WEB_ORIGIN"]?.trim() || "http://127.0.0.1:4174",
              ...(secureCookie === undefined ? {} : { secureCookie }),
            },
          }),
    });

    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
      if (shutdownStarted) return;
      shutdownStarted = true;
      server?.app.log.info({ signal }, "stopping Relay QA Hub API");
      try {
        await closeRuntime(server, worker, relayPump, backupRunner);
        process.exitCode = 0;
      } catch (error: unknown) {
        server?.app.log.error({ error, signal }, "failed to stop Relay QA Hub API");
        process.exitCode = 1;
      }
    };

    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));

    backupRunner = createApiBackupRunner({
      config: backupConfig,
      worker,
      logger: server.app.log,
    });
    await backupRunner.start();
    if (shutdownStarted) return;

    const address = await server.start({
      host: process.env["QA_HUB_API_HOST"] ?? DEFAULT_API_HOST,
      port: resolvePort(process.env["QA_HUB_API_PORT"]),
    });
    server.app.log.info(
      { address, databaseFile: storage.databaseFile },
      "Relay QA Hub API started",
    );
    if (fakeRelayEndpoint) {
      relayPump = startMobileRelayOutboxPump({
        worker,
        endpoint: fakeRelayEndpoint,
        onDelivery: (claim) =>
          server?.app.log.info(
            { outboxMessageId: claim.outboxMessageId, handoffId: claim.handoffId },
            "fake Relay handoff submitted",
          ),
        onRetry: (claim, errorCode) =>
          server?.app.log.warn(
            { outboxMessageId: claim.outboxMessageId, errorCode },
            "fake Relay handoff scheduled for retry",
          ),
      });
    }
  } catch (error: unknown) {
    if (server) {
      server.app.log.error({ error }, "Relay QA Hub API failed to start");
    } else {
      console.error("Relay QA Hub API failed to initialize", error);
    }
    process.exitCode = 1;
    await closeRuntime(server, worker, relayPump, backupRunner).catch(() => undefined);
  }
}

await run();
