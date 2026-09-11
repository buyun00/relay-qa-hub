import { importExecutionHeld } from "./import-execution-hold.js";
import { mkdirSync, readFileSync } from "node:fs";
import { applyParallelInstanceEnvironment } from "./parallel-instance.js";
import { parseAndroidUpdateChannel } from "./android-updates.js";
import { ProjectManagementService } from "./project-management.js";
import { ProjectRequestContext } from "./project-request-context.js";
import { ProjectComponentsRuntime } from "./project-components-runtime.js";
import type { QingyuLinkPersistence } from "./qingyu-integration.js";
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
import { closeApiRuntime, createApiServer, type ApiServer } from "./server.js";
import { createSqliteApiHealthProbe } from "./health.js";
import { createSqliteMobileAttachmentStore } from "./sqlite-mobile-attachment-store.js";
import { createSqliteMobileBuildStore } from "./sqlite-mobile-build-store.js";
import { createSqliteMobileDuplicateStore } from "./sqlite-mobile-duplicate-store.js";
import { createSqliteMobileInboxStore } from "./sqlite-mobile-inbox-store.js";
import { createSqliteMobileProjectDirectoryStore } from "./sqlite-mobile-project-directory-store.js";
import { createSqliteMobileUserManagementStore } from "./sqlite-mobile-user-management-store.js";
import { createSqliteMobileBugStore } from "./sqlite-mobile-bug-store.js";
import { createSqliteMobileCaptureStore } from "./sqlite-mobile-capture-store.js";
import { createSqliteMobileRelayStore } from "./sqlite-mobile-relay-store.js";
import { createSqliteMobileRelayWebhookStore } from "./sqlite-mobile-relay-webhook-store.js";
import { createSqliteMobileVerificationStore } from "./sqlite-mobile-verification-store.js";
import { createSqliteWorkflowProjectionStore } from "./sqlite-workflow-projection-store.js";
import { createSqliteRepairAttemptTerminalStore } from "./sqlite-repair-attempt-terminal-store.js";
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
import { parseRelayEndpoint, type MobileRelayOutboxPump } from "./mobile-relay-outbox.js";
import { deriveMobileReadCursorSigningKey } from "./mobile-read-cursor-key.js";
import { deriveMobileReplayDigestKey } from "./mobile-replay-digest.js";

const MOBILE_SCOPE: MobileScopeBootstrap = Object.freeze({
  accountId: "10000000-0000-4000-8000-000000000020",
  projectId: "10000000-0000-4000-8000-000000000004",
  actorId: "10000000-0000-4000-8000-000000000003",
  membershipId: "10000000-0000-4000-8000-000000000005",
  projectKey: "LOCAL",
  projectName: "OZDQP",
  accountDisplayName: "OZDQP",
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

async function run(): Promise<void> {
  const parallelInstance = applyParallelInstanceEnvironment(process.env);
  console.info(
    JSON.stringify({
      event: "parallel-instance.validated",
      instanceId: parallelInstance.instanceId,
      sourceRoot: parallelInstance.sourceRoot,
      dataRoot: parallelInstance.dataRoot,
      apiPort: parallelInstance.apiPort,
    }),
  );
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
  mkdirSync(storage.evidenceRoot, { recursive: true });
  mkdirSync(storage.quarantineRoot, { recursive: true });
  const debugBearerToken = requireMobileAccessToken();
  const mobileReplayDigestKey = deriveMobileReplayDigestKey(debugBearerToken);
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
    mobileBugCursorSigningKey: deriveMobileReadCursorSigningKey(debugBearerToken),
    executionHoldFile: join(storage.dataRoot, ".qa-hub-import-hold.json"),
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
  let projectComponentsRuntime: ProjectComponentsRuntime | undefined;
  let relayPump: MobileRelayOutboxPump | undefined;
  let backupRunner: ApiBackupRunner | undefined;
  let shutdownStarted = false;
  const projectContext = new ProjectRequestContext();
  const requestScope = projectContext.scope(MOBILE_SCOPE);
  const projectManagementService = new ProjectManagementService({
    worker,
    accountId: MOBILE_SCOPE.accountId,
    gmUserId: parallelInstance.gmUserId,
    onboardingSecret: process.env["QA_HUB_PROJECT_ONBOARDING_SECRET"]!,
    publicWebBaseUrl: parallelInstance.publicWebBaseUrl,
  });

  try {
    const peopleSeededAt = new Date().toISOString();
    await worker.ensureMobileScope({
      ...MOBILE_SCOPE,
      actorId: parallelInstance.gmUserId,
      membershipId: qaMembershipId(parallelInstance.gmUserId),
      actorDisplayName: "Preview GM",
      actorEmail: qaLoginEmail(MOBILE_SCOPE.accountId, "Preview GM"),
      createdAt: peopleSeededAt,
    });
    await worker.ensureMobileRelayRoles({
      ...MOBILE_SCOPE,
      actorId: parallelInstance.gmUserId,
      membershipId: qaMembershipId(parallelInstance.gmUserId),
      createdAt: peopleSeededAt,
    });
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
        : createSqliteBrowserAuthStore({ worker });
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
    const mobileBugStore = createSqliteMobileBugStore({ worker, scope: requestScope });
    const mobileAttachmentStore = createSqliteMobileAttachmentStore({
      worker,
      scope: requestScope,
    });
    const configuredBuildSha = process.env["QA_HUB_BUILD_SHA"];
    projectComponentsRuntime = new ProjectComponentsRuntime({
      root: join(parallelInstance.runtimeRoot, "components"),
      credentialRoot: join(parallelInstance.runtimeRoot, "credentials"),
      instanceId: parallelInstance.instanceId,
      evidenceRoot: storage.evidenceRoot,
      executionHeld: () => importExecutionHeld(storage.dataRoot),
      management: projectManagementService,
      worker,
      storesForProject: (projectId, componentVersion, relayBinding) => {
        const scope = Object.freeze({ ...MOBILE_SCOPE, projectId });
        const forActor = <T extends object>(store: T): T =>
          new Proxy(store, {
            get(target, property, receiver) {
              const method: unknown = Reflect.get(target, property, receiver);
              if (typeof method !== "function") return method;
              return (command: unknown, ...rest: unknown[]) => {
                const actorId =
                  command && typeof command === "object" && "actorId" in command
                    ? command.actorId
                    : undefined;
                return worker.runWithRequestAuthorization(
                  actorId === parallelInstance.gmUserId
                    ? {
                        gm: {
                          accountId: scope.accountId,
                          projectId,
                          actorId: parallelInstance.gmUserId,
                        },
                      }
                    : {},
                  () => Reflect.apply(method, target, [command, ...rest]),
                );
              };
            },
          });
        const qingyuLinks: QingyuLinkPersistence = {
          getBugLink: (bugId) =>
            worker.getQingyuLink({ accountId: scope.accountId, projectId, bugId }),
          getByExternal: (externalProjectId, defectId) =>
            worker.getQingyuLinkByExternal({
              accountId: scope.accountId,
              projectId,
              externalProjectId,
              defectId,
            }),
          put: (link) =>
            worker.putQingyuLink({
              accountId: scope.accountId,
              projectId,
              link,
              updatedAt: new Date().toISOString(),
            }),
          updateSync: (link, values) =>
            worker.updateQingyuLinkSync({
              accountId: scope.accountId,
              projectId,
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
        return {
          bugs: forActor(createSqliteMobileBugStore({ worker, scope })),
          relay: forActor(
            createSqliteMobileRelayStore({
              worker,
              scope,
              relayDispatchEnabled: relayBinding !== undefined && componentVersion > 0,
              ...(relayBinding ?? {}),
              canStart: async () => {
                if (importExecutionHeld(storage.dataRoot)) return false;
                const result = await worker.projectManagement<{
                  items: { key: string; enabled: boolean }[];
                }>({
                  operation: "components",
                  accountId: scope.accountId,
                  projectId,
                  actorId: parallelInstance.gmUserId,
                  isGm: true,
                });
                return result.items.some((item) => item.key === "relay.production" && item.enabled);
              },
            }),
          ),
          attachments: forActor(createSqliteMobileAttachmentStore({ worker, scope })),
          projects: forActor(
            createSqliteMobileProjectDirectoryStore({
              worker,
              scope,
              gmUserId: parallelInstance.gmUserId,
            }),
          ),
          qingyuLinks,
        };
      },
    });
    server = createApiServer({
      projectComponentsRuntime,
      automationPublicApiOrigin: `http://${parallelInstance.apiHost}:${parallelInstance.apiPort}`,
      projectManagementService,
      projectRequestContext: projectContext,
      isolateLegacyComponents: true,
      ...(configuredBuildSha === undefined ? {} : { buildSha: configuredBuildSha }),
      androidUpdateRoot: readAndroidUpdateRoot(storage.dataRoot),
      androidUpdateChannel: parseAndroidUpdateChannel(process.env["QA_HUB_ANDROID_UPDATE_CHANNEL"]),
      androidUpdatePackageName:
        process.env["QA_HUB_ANDROID_PACKAGE_NAME"] ?? "com.relayqahub.android.preview.debug",
      incrementUploadRoot: join(storage.dataRoot, "integrations", "increment-upload"),
      ...(relayRuntime.endpoint && relayRuntime.bearerToken && relayRuntime.qaInstanceId
        ? {
            productionConfig: {
              endpoint: relayRuntime.endpoint.toString(),
              bearerToken: relayRuntime.bearerToken,
              qaInstanceId: relayRuntime.qaInstanceId,
              stateRoot: join(storage.dataRoot, "integrations", "production"),
            },
          }
        : {}),
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
      // Legacy singleton integrations remain disconnected until their per-project
      // adapters are configured. Creating this service does not authorize execution.
      mobileBuildStore: createSqliteMobileBuildStore({ worker, scope: requestScope }),
      mobileVerificationStore: createSqliteMobileVerificationStore({ worker, scope: requestScope }),
      workflowProjectionStore: createSqliteWorkflowProjectionStore({ worker, scope: requestScope }),
      terminalAttemptStore: createSqliteRepairAttemptTerminalStore({ worker }),
      mobileHumanWorkflowStore: createSqliteMobileHumanWorkflowStore({
        worker,
        scope: requestScope,
      }),
      mobileCommentStore: createSqliteMobileCommentStore({ worker, scope: requestScope }),
      mobileDuplicateStore: createSqliteMobileDuplicateStore({ worker, scope: requestScope }),
      mobileNotificationStore: createSqliteMobileInboxStore({
        worker,
        scope: requestScope,
        replayDigestKey: mobileReplayDigestKey,
      }),
      notificationHintChannelEnabled: readNotificationHintChannelEnabled(),
      mobileProjectDirectoryStore: createSqliteMobileProjectDirectoryStore({
        worker,
        scope: requestScope,
        gmUserId: parallelInstance.gmUserId,
      }),
      mobileUserManagementStore: createSqliteMobileUserManagementStore({
        worker,
        scope: requestScope,
        protectedUserIds: [...activePeople.map((person) => person.id), parallelInstance.gmUserId],
        identityDirectory: loginDirectory,
      }),
      mobileMetricsStore: createSqliteMobileMetricsStore({ worker, scope: requestScope }),
      mobileCaptureStore: createSqliteMobileCaptureStore({ worker, scope: requestScope }),
      mobileRelayStore: createSqliteMobileRelayStore({
        worker,
        scope: requestScope,
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
              projectCodeLogin: (name, projectName, joinCode, now, clientKey) =>
                projectManagementService.joinWithCode(name, projectName, joinCode, now, clientKey),
              cookieName: parallelInstance.cookieName,
              gm: {
                userId: parallelInstance.gmUserId,
                password: process.env["QA_HUB_GM_PASSWORD"]!,
              },
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
        await closeApiRuntime({
          server,
          componentsRuntime: projectComponentsRuntime,
          worker,
          relayPump,
          backupRunner,
        });
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
    const address = await server.start({
      host: process.env["QA_HUB_API_HOST"] ?? DEFAULT_API_HOST,
      port: resolvePort(process.env["QA_HUB_API_PORT"]),
    });
    server.app.log.info(
      { address, databaseFile: storage.databaseFile },
      "Relay QA Hub API started",
    );

    // Archive I/O runs in its own worker. Start listening first so a slow
    // archive volume cannot make the API appear offline during startup.
    await backupRunner.start();
    if (shutdownStarted) return;

    // Relay pumps belong to immutable project component versions.
  } catch (error: unknown) {
    if (server) {
      server.app.log.error({ error }, "Relay QA Hub API failed to start");
    } else {
      console.error("Relay QA Hub API failed to initialize", error);
    }
    process.exitCode = 1;
    await closeApiRuntime({
      server,
      componentsRuntime: projectComponentsRuntime,
      worker,
      relayPump,
      backupRunner,
    }).catch((cleanupError: unknown) => {
      if (server) server.app.log.error({ error: cleanupError }, "API startup cleanup failed");
      else console.error("API startup cleanup failed", cleanupError);
    });
  }
}

await run();
