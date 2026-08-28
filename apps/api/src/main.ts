import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

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
import {
  DEFAULT_API_HOST,
  resolveEvidenceMinFreeBytes,
  resolveHealthProbeTimeoutMs,
  resolvePort,
  resolveWebOrigins,
} from "./config.js";
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
  loadQaPeopleConfig,
  normalizeQaLoginName,
  QaLoginDirectory,
  qaLoginEmail,
  qaMembershipId,
  qaUserId,
} from "./people-config.js";
import {
  parseRelayEndpoint,
  startMobileRelayOutboxPump,
  type MobileRelayOutboxPump,
} from "./mobile-relay-outbox.js";
import { QingyuClient } from "./qingyu-client.js";
import { createQingyuIntegration, type QingyuLinkPersistence } from "./qingyu-integration.js";

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

const RELAY_INSTANCE_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/u;
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

interface RelayRuntimeConfiguration {
  readonly endpoint?: URL;
  readonly bearerToken?: string;
  readonly webhookSecret?: string;
  readonly relayInstanceId?: string;
  readonly qaInstanceId?: string;
  readonly relayPrincipalId?: string;
}

function readRuntimeSecret(
  inlineName: string,
  fileName: string,
  label: string,
): string | undefined {
  const inline = process.env[inlineName]?.trim();
  const secretFile = process.env[fileName]?.trim();
  if (inline !== undefined && secretFile !== undefined) {
    throw new Error(`${label} must use either an environment value or a secret file, not both`);
  }
  let configured = inline;
  if (secretFile !== undefined) {
    try {
      configured = readFileSync(secretFile, "utf8").trim();
    } catch {
      throw new Error(`${label} secret file is not readable`);
    }
  }
  if (configured === undefined) return undefined;
  if (configured.length < 32 || /\s/u.test(configured)) {
    throw new Error(`${label} must contain at least 32 non-whitespace characters`);
  }
  return configured;
}

function readRelayIdentifier(name: string, label: string, pattern: RegExp): string | undefined {
  const configured = process.env[name]?.trim();
  if (configured === undefined) return undefined;
  if (!pattern.test(configured)) throw new Error(`${label} is invalid`);
  return configured;
}

function readRelayRuntimeConfiguration(): RelayRuntimeConfiguration {
  const endpoint = parseRelayEndpoint(process.env["QA_HUB_RELAY_M2M_URL"]);
  const bearerToken = readRuntimeSecret(
    "QA_HUB_RELAY_M2M_TOKEN",
    "QA_HUB_RELAY_M2M_TOKEN_FILE",
    "QA Hub Relay M2M token",
  );
  const webhookSecret = readRuntimeSecret(
    "QA_HUB_RELAY_WEBHOOK_SECRET",
    "QA_HUB_RELAY_WEBHOOK_SECRET_FILE",
    "QA Hub Relay webhook secret",
  );
  const relayInstanceId = readRelayIdentifier(
    "QA_HUB_RELAY_INSTANCE_ID",
    "QA_HUB_RELAY_INSTANCE_ID",
    RELAY_INSTANCE_PATTERN,
  );
  const qaInstanceId = readRelayIdentifier(
    "QA_HUB_RELAY_QA_INSTANCE_ID",
    "QA_HUB_RELAY_QA_INSTANCE_ID",
    RELAY_INSTANCE_PATTERN,
  );
  const relayPrincipalId = readRelayIdentifier(
    "QA_HUB_RELAY_PRINCIPAL_ID",
    "QA_HUB_RELAY_PRINCIPAL_ID",
    UUID_PATTERN,
  );
  const configuredValues = [
    endpoint,
    bearerToken,
    webhookSecret,
    relayInstanceId,
    qaInstanceId,
    relayPrincipalId,
  ];
  const configuredCount = configuredValues.filter((value) => value !== undefined).length;
  if (configuredCount !== 0 && configuredCount !== configuredValues.length) {
    throw new Error(
      "Relay integration requires endpoint, token, webhook secret, instance IDs, and principal ID together",
    );
  }
  return {
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(bearerToken === undefined ? {} : { bearerToken }),
    ...(webhookSecret === undefined ? {} : { webhookSecret }),
    ...(relayInstanceId === undefined ? {} : { relayInstanceId }),
    ...(qaInstanceId === undefined ? {} : { qaInstanceId }),
    ...(relayPrincipalId === undefined ? {} : { relayPrincipalId }),
  };
}

type WebAuthMode = "session" | "debug";

function readWebAuthMode(): WebAuthMode {
  const configured = process.env["QA_HUB_WEB_AUTH_MODE"]?.trim().toLowerCase();
  if (configured === undefined || configured.length === 0 || configured === "session") {
    return "session";
  }
  if (configured === "debug") return "debug";
  throw new Error("QA_HUB_WEB_AUTH_MODE must be session or debug");
}

function readWebSessionSecret(mode: WebAuthMode): string | undefined {
  const configured = process.env["QA_HUB_WEB_SESSION_SECRET"]?.trim();
  if (configured === undefined || configured.length === 0) {
    if (mode === "session") {
      throw new Error("QA_HUB_WEB_SESSION_SECRET is required in session auth mode");
    }
    return undefined;
  }
  if (mode === "debug") {
    throw new Error("QA_HUB_WEB_SESSION_SECRET must not be set in debug auth mode");
  }
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

function readAndroidUpdateRoot(dataRoot: string): string {
  const configured = process.env["QA_HUB_ANDROID_UPDATE_ROOT"]?.trim();
  const updateRoot =
    configured === undefined ? join(dataRoot, "android-updates", "stable") : configured;
  if (!isAbsolute(updateRoot)) {
    throw new Error("QA_HUB_ANDROID_UPDATE_ROOT must be an absolute path");
  }
  return resolve(updateRoot);
}

function readQingyuStatePath(dataRoot: string): string {
  const configured = process.env["QA_HUB_QINGYU_STATE_FILE"]?.trim();
  const statePath =
    configured === undefined ? join(dataRoot, "integrations", "qingyu-state.enc.json") : configured;
  if (!isAbsolute(statePath)) throw new Error("QA_HUB_QINGYU_STATE_FILE must be an absolute path");
  return resolve(statePath);
}

function readQingyuBaseUrl(): string | undefined {
  const value = process.env["QA_HUB_QINGYU_BASE_URL"]?.trim();
  if (value === undefined) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("QA_HUB_QINGYU_BASE_URL must use HTTP or HTTPS");
  }
  return url.origin;
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
  const relayRuntime = readRelayRuntimeConfiguration();
  const webAuthMode = readWebAuthMode();
  const webSessionSecret = readWebSessionSecret(webAuthMode);
  const secureCookie = webAuthMode === "session" ? readSecureCookie() : undefined;
  const peopleConfig = loadQaPeopleConfig(process.env["QA_HUB_PEOPLE_CONFIG_FILE"]);
  if (peopleConfig.projectKey !== MOBILE_SCOPE.projectKey) {
    throw new Error("QA Hub people config projectKey does not match the configured project scope");
  }
  const activePeople = peopleConfig.people.filter((person) => person.active);
  const loginDirectory = new QaLoginDirectory(activePeople);
  const webBootstrapPassword = process.env["QA_HUB_BOOTSTRAP_ADMIN_PASSWORD"];
  if (webAuthMode === "debug" && webBootstrapPassword !== undefined) {
    throw new Error("QA_HUB_BOOTSTRAP_ADMIN_PASSWORD requires session auth mode");
  }
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
    ...(relayRuntime.relayInstanceId === undefined
      ? {}
      : { relayInstanceId: relayRuntime.relayInstanceId }),
    ...(relayRuntime.qaInstanceId === undefined ? {} : { qaInstanceId: relayRuntime.qaInstanceId }),
    ...(relayRuntime.relayPrincipalId === undefined
      ? {}
      : { relayPrincipalId: relayRuntime.relayPrincipalId }),
  });
  let server: ApiServer | undefined;
  let relayPump: MobileRelayOutboxPump | undefined;
  let backupRunner: ApiBackupRunner | undefined;
  let shutdownStarted = false;

  try {
    const peopleSeededAt = new Date().toISOString();
    for (const person of activePeople) {
      const personScope: MobileScopeBootstrap = {
        ...MOBILE_SCOPE,
        createdAt: peopleSeededAt,
        actorId: person.id,
        membershipId: qaMembershipId(person.id),
        actorDisplayName: person.displayName,
        actorEmail: qaLoginEmail(MOBILE_SCOPE.accountId, person.displayName),
      };
      await worker.ensureMobileScope(personScope);
      await worker.ensureMobileRelayRoles(personScope);
    }
    const activeAccountUsers = await worker.listActiveAccountUsers(MOBILE_SCOPE.accountId);
    for (const user of activeAccountUsers) {
      loginDirectory.register({ id: user.userId, displayName: user.displayName });
    }
    const browserAuthStore =
      webAuthMode === "debug" || webSessionSecret === undefined
        ? undefined
        : createSqliteBrowserAuthStore({
            worker,
            canonicalizePrincipal: (principal) => {
              const canonical = loginDirectory.canonicalize({
                id: principal.userId,
                displayName: principal.displayName,
              });
              return canonical.id === principal.userId
                ? principal
                : {
                    ...principal,
                    userId: canonical.id,
                    actorId: canonical.id,
                    email: qaLoginEmail(MOBILE_SCOPE.accountId, canonical.displayName),
                    displayName: canonical.displayName,
                  };
            },
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
    const mobileBugStore = createSqliteMobileBugStore({ worker, scope: MOBILE_SCOPE });
    const mobileAttachmentStore = createSqliteMobileAttachmentStore({
      worker,
      scope: MOBILE_SCOPE,
    });
    const qingyuLinkStore: QingyuLinkPersistence = {
      getBugLink: (bugId: string) =>
        worker.getQingyuLink({
          accountId: MOBILE_SCOPE.accountId,
          projectId: MOBILE_SCOPE.projectId,
          bugId,
        }),
      getByExternal: (externalProjectId: string, defectId: string) =>
        worker.getQingyuLinkByExternal({
          accountId: MOBILE_SCOPE.accountId,
          projectId: MOBILE_SCOPE.projectId,
          externalProjectId,
          defectId,
        }),
      put: (link) =>
        worker.putQingyuLink({
          accountId: MOBILE_SCOPE.accountId,
          projectId: MOBILE_SCOPE.projectId,
          link,
          updatedAt: new Date().toISOString(),
        }),
      updateSync: (link, values) =>
        worker.updateQingyuLinkSync({
          accountId: MOBILE_SCOPE.accountId,
          projectId: MOBILE_SCOPE.projectId,
          bugId: link.bugId,
          expectedVersion: link.version,
          syncStatus: values.syncStatus,
          syncAttempts: values.syncAttempts,
          syncedAt: values.syncedAt,
          externalStatus: values.externalStatus,
          lastSyncErrorCode: values.lastSyncErrorCode,
          lastSyncErrorMessage: values.lastSyncErrorMessage,
          lastSyncAt: values.lastSyncAt,
          updatedAt: new Date().toISOString(),
        }),
    };
    const qingyuBaseUrl = readQingyuBaseUrl();
    const qingyuIntegration = await createQingyuIntegration({
      statePath: readQingyuStatePath(storage.dataRoot),
      secret: webSessionSecret ?? debugBearerToken,
      qaProjectId: MOBILE_SCOPE.projectId,
      mobileBugStore,
      mobileAttachmentStore,
      linkStore: qingyuLinkStore,
      client: new QingyuClient(qingyuBaseUrl === undefined ? {} : { baseUrl: qingyuBaseUrl }),
    });
    const configuredBuildSha = process.env["QA_HUB_BUILD_SHA"];
    server = createApiServer({
      ...(configuredBuildSha === undefined ? {} : { buildSha: configuredBuildSha }),
      androidUpdateRoot: readAndroidUpdateRoot(storage.dataRoot),
      healthProbe: createSqliteApiHealthProbe({
        worker,
        evidenceRoot: storage.evidenceRoot,
        quarantineRoot: storage.quarantineRoot,
        timeoutMs: resolveHealthProbeTimeoutMs(process.env["QA_HUB_HEALTH_PROBE_TIMEOUT_MS"]),
        minimumFreeBytes: BigInt(
          resolveEvidenceMinFreeBytes(process.env["QA_HUB_EVIDENCE_MIN_FREE_BYTES"]),
        ),
      }),
      mobileBugStore,
      mobileAttachmentStore,
      qingyuIntegration,
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
        identityDirectory: loginDirectory,
      }),
      mobileMetricsStore: createSqliteMobileMetricsStore({ worker, scope: MOBILE_SCOPE }),
      mobileCaptureStore: createSqliteMobileCaptureStore({ worker, scope: MOBILE_SCOPE }),
      mobileRelayStore: createSqliteMobileRelayStore({
        worker,
        scope: MOBILE_SCOPE,
        relayDispatchEnabled: relayRuntime.endpoint !== undefined,
      }),
      ...(relayRuntime.webhookSecret === undefined
        ? {}
        : {
            mobileRelayWebhookStore: createSqliteMobileRelayWebhookStore({
              worker,
              scope: MOBILE_SCOPE,
            }),
            relayWebhookSecret: relayRuntime.webhookSecret,
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
              passwordlessLogin: async (name, now) => {
                const normalized = normalizeQaLoginName(name);
                const canonical = loginDirectory.resolveLogin(normalized.displayName);
                const userId = canonical?.id ?? qaUserId(MOBILE_SCOPE.accountId, normalized.key);
                const displayName = canonical?.displayName ?? normalized.displayName;
                const personScope: MobileScopeBootstrap = {
                  ...MOBILE_SCOPE,
                  createdAt: now,
                  actorId: userId,
                  membershipId: qaMembershipId(userId),
                  actorDisplayName: displayName,
                  actorEmail: qaLoginEmail(MOBILE_SCOPE.accountId, displayName),
                };
                await worker.ensureMobileScope(personScope);
                await worker.ensureMobileRelayRoles(personScope);
                loginDirectory.register({ id: userId, displayName });
                return { userId };
              },
              sessionSecret: webSessionSecret,
              webOrigins: resolveWebOrigins(
                process.env["QA_HUB_WEB_ORIGINS"],
                process.env["QA_HUB_WEB_ORIGIN"],
              ),
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
    if (relayRuntime.endpoint !== undefined && relayRuntime.bearerToken !== undefined) {
      relayPump = startMobileRelayOutboxPump({
        worker,
        endpoint: relayRuntime.endpoint,
        bearerToken: relayRuntime.bearerToken,
        ...(relayRuntime.qaInstanceId === undefined
          ? {}
          : { qaInstanceId: relayRuntime.qaInstanceId }),
        evidenceRoot: storage.evidenceRoot,
        onDelivery: (claim, _status, receipt) =>
          server?.app.log.info(
            {
              outboxMessageId: claim.outboxMessageId,
              handoffId: claim.handoffId,
              relayTaskId: receipt.taskId,
              relayTurnId: receipt.turnId,
            },
            "Relay handoff submitted",
          ),
        onRetry: (claim, errorCode, schedule) =>
          server?.app.log.warn(
            {
              outboxMessageId: claim.outboxMessageId,
              errorCode,
              deadLetter: schedule.deadLetter,
              nextAttemptAt: schedule.nextAttemptAt,
            },
            schedule.deadLetter
              ? "Relay handoff moved to dead letter"
              : "Relay handoff scheduled for retry",
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
