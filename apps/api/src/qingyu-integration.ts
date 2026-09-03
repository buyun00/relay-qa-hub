import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { MobileAttachmentStore } from "./mobile-attachments.js";
import type { MobileBug, MobileBugStore, MobileCreateBugRequest } from "./mobile-bugs.js";
import {
  isActionableQingyuDefect,
  QingyuClient,
  QingyuError,
  type QingyuCredentials,
  type QingyuDefect,
  type QingyuLoginChallenge,
  type QingyuProject,
} from "./qingyu-client.js";

const STATE_FORMAT = "relay-qa-hub-qingyu-state-v1";
const ENVELOPE_FORMAT = "relay-qa-hub-qingyu-encrypted-v1";

export const QINGYU_SESSION_PATH = "/api/v1/integrations/qingyu/session" as const;
export const QINGYU_LOGIN_START_PATH = "/api/v1/integrations/qingyu/login/start" as const;
export const QINGYU_LOGIN_STATUS_PATH = "/api/v1/integrations/qingyu/login/status" as const;
export const QINGYU_LOGOUT_PATH = "/api/v1/integrations/qingyu/logout" as const;
export const QINGYU_PROJECTS_PATH = "/api/v1/integrations/qingyu/projects" as const;
export const QINGYU_DEFECTS_PATH = "/api/v1/integrations/qingyu/defects" as const;
export const QINGYU_IMPORT_PATH = "/api/v1/integrations/qingyu/import" as const;
export const QINGYU_BUG_LINK_PATH = "/api/v1/bugs/:bugId/integrations/qingyu" as const;
export const QINGYU_BUG_RESOLVE_PATH = "/api/v1/bugs/:bugId/integrations/qingyu/resolve" as const;

interface StoredSession {
  readonly actorId: string;
  readonly credentials: QingyuCredentials;
  readonly connectedAt: string;
  readonly lastUsedAt: string;
}

export type QingyuSyncStatus = "not_synced" | "syncing" | "succeeded" | "failed";

export interface QingyuBugLink {
  readonly bugId: string;
  readonly qaProjectId: string;
  readonly externalProjectId: string;
  readonly defectId: string;
  readonly defectCode: string | null;
  readonly defectTitle: string;
  readonly defectUrl: string;
  readonly importedByActorId: string;
  readonly qingyuUserId: string;
  readonly qingyuUserName: string;
  readonly importedAt: string;
  readonly syncStatus: QingyuSyncStatus;
  readonly syncAttempts: number;
  readonly syncedAt: string | null;
  readonly externalStatus: string | null;
  readonly lastSyncErrorCode: string | null;
  readonly lastSyncErrorMessage: string | null;
  readonly lastSyncAt: string | null;
  readonly version: number;
}

export interface QingyuLinkPersistence {
  readonly getBugLink: (bugId: string) => Promise<QingyuBugLink | null>;
  readonly getByExternal: (
    externalProjectId: string,
    defectId: string,
  ) => Promise<QingyuBugLink | null>;
  readonly put: (link: Omit<QingyuBugLink, "version">) => Promise<QingyuBugLink>;
  readonly updateSync: (
    link: QingyuBugLink,
    values: Pick<
      QingyuBugLink,
      | "syncStatus"
      | "syncAttempts"
      | "syncedAt"
      | "externalStatus"
      | "lastSyncErrorCode"
      | "lastSyncErrorMessage"
      | "lastSyncAt"
    >,
  ) => Promise<QingyuBugLink>;
}

interface PendingImport {
  readonly key: string;
  readonly actorId: string;
  readonly externalProjectId: string;
  readonly defectId: string;
  readonly clientSubmissionId: string;
  readonly request: MobileCreateBugRequest;
  readonly defect: QingyuDefect;
  readonly qingyuUser: QingyuCredentials["user"];
  readonly skippedImages: number;
  readonly preparedAt: string;
}

interface QingyuState {
  readonly format: typeof STATE_FORMAT;
  readonly sessions: readonly StoredSession[];
  readonly links: readonly QingyuBugLink[];
  readonly pendingImports: readonly PendingImport[];
  readonly savedAt: string;
}

interface EncryptedEnvelope {
  readonly format: typeof ENVELOPE_FORMAT;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

export interface QingyuPublicSession {
  readonly authenticated: boolean;
  readonly user: QingyuCredentials["user"] | null;
  readonly login: Pick<QingyuLoginChallenge, "status" | "qrContent" | "expiresAt"> | null;
}

export interface QingyuDefectListItem extends QingyuDefect {
  readonly actionable: boolean;
  readonly importedBugId: string | null;
}

export interface QingyuImportItemResult {
  readonly defectId: string;
  readonly status: "created" | "already_imported" | "skipped_terminal" | "failed";
  readonly bug: MobileBug | null;
  readonly skippedImages: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface QingyuIntegration {
  readonly session: (actorId: string) => QingyuPublicSession;
  readonly startLogin: (actorId: string) => Promise<QingyuPublicSession>;
  readonly pollLogin: (actorId: string) => Promise<QingyuPublicSession>;
  readonly logout: (actorId: string) => Promise<QingyuPublicSession>;
  readonly listProjects: (actorId: string) => Promise<readonly QingyuProject[]>;
  readonly listOwnDefects: (
    actorId: string,
    externalProjectId: string,
  ) => Promise<{ readonly defects: readonly QingyuDefectListItem[]; readonly total: number }>;
  readonly importOwnDefects: (
    actorId: string,
    externalProjectId: string,
    defectIds?: readonly string[],
  ) => Promise<{ readonly items: readonly QingyuImportItemResult[] }>;
  readonly getBugLink: (bugId: string) => Promise<QingyuBugLink | null>;
  readonly beforeHumanClose: (
    actorId: string,
    bugId: string,
    options?: { readonly verifyRemote?: boolean },
  ) => Promise<{ readonly link: QingyuBugLink; readonly alreadyResolved: boolean } | null>;
}

function emptyState(): QingyuState {
  return {
    format: STATE_FORMAT,
    sessions: [],
    links: [],
    pendingImports: [],
    savedAt: new Date(0).toISOString(),
  };
}

function encryptionKey(secret: string): Buffer {
  if (secret.length < 16)
    throw new Error("Qingyu integration secret must contain at least 16 characters");
  return createHash("sha256").update(`relay-qa-hub:qingyu:${secret}`, "utf8").digest();
}

function decodeState(value: unknown): QingyuState {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Qingyu integration state must be an object");
  const state = value as Partial<QingyuState>;
  if (
    state.format !== STATE_FORMAT ||
    !Array.isArray(state.sessions) ||
    !Array.isArray(state.links) ||
    !Array.isArray(state.pendingImports)
  ) {
    throw new Error("Qingyu integration state has an unsupported format");
  }
  return state as QingyuState;
}

class EncryptedStateFile {
  readonly statePath: string;
  readonly key: Buffer;

  constructor(statePath: string, secret: string) {
    this.statePath = resolve(statePath);
    this.key = encryptionKey(secret);
  }

  async load(): Promise<QingyuState> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.statePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw error;
    }
    const envelope = JSON.parse(bytes.toString("utf8")) as EncryptedEnvelope;
    if (envelope.format !== ENVELOPE_FORMAT)
      throw new Error("Qingyu encrypted state has an unsupported format");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    return decodeState(JSON.parse(plaintext.toString("utf8")));
  }

  async save(state: QingyuState): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const plaintext = Buffer.from(
      JSON.stringify({ ...state, savedAt: new Date().toISOString() }),
      "utf8",
    );
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: EncryptedEnvelope = {
      format: ENVELOPE_FORMAT,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(envelope)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.statePath);
  }
}

function deterministicUuid(input: string): string {
  const digest = Buffer.from(createHash("sha256").update(input, "utf8").digest().subarray(0, 16));
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x40;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function severity(value: string | null): "S0" | "S1" | "S2" | "S3" | "S4" {
  const normalized = String(value ?? "").toUpperCase();
  const digit = normalized.match(/[0-4]/u)?.[0];
  if (digit !== undefined) return `S${digit}` as "S0" | "S1" | "S2" | "S3" | "S4";
  if (/致命|阻断|BLOCKER|CRITICAL/iu.test(normalized)) return "S0";
  if (/严重|MAJOR|HIGH/iu.test(normalized)) return "S1";
  if (/轻微|MINOR|LOW/iu.test(normalized)) return "S3";
  return "S2";
}

function priority(value: string | null): "P0" | "P1" | "P2" | "P3" | "P4" {
  const normalized = String(value ?? "").toUpperCase();
  const digit = normalized.match(/[0-4]/u)?.[0];
  if (digit !== undefined) return `P${digit}` as "P0" | "P1" | "P2" | "P3" | "P4";
  if (/紧急|URGENT|CRITICAL/iu.test(normalized)) return "P0";
  if (/高|HIGH/iu.test(normalized)) return "P1";
  if (/低|LOW/iu.test(normalized)) return "P3";
  return "P2";
}

function errorDetails(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof QingyuError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: "QINGYU_IMPORT_FAILED", message: error.message };
  return { code: "QINGYU_IMPORT_FAILED", message: "轻语 Bug 导入失败" };
}

export async function createQingyuIntegration(options: {
  readonly statePath: string;
  readonly secret: string;
  readonly qaProjectId: string;
  readonly mobileBugStore: MobileBugStore;
  readonly mobileAttachmentStore: MobileAttachmentStore;
  readonly linkStore: QingyuLinkPersistence;
  readonly client?: QingyuClient;
  readonly now?: () => Date;
}): Promise<QingyuIntegration> {
  const stateFile = new EncryptedStateFile(options.statePath, options.secret);
  let state = await stateFile.load();
  const client = options.client ?? new QingyuClient();
  const now = options.now ?? (() => new Date());
  const loginChallenges = new Map<string, QingyuLoginChallenge>();
  let mutationQueue = Promise.resolve();

  const mutate = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = mutationQueue;
    let release!: () => void;
    mutationQueue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const save = async (): Promise<void> => stateFile.save(state);
  const storedSession = (actorId: string): StoredSession | null =>
    state.sessions.find((item) => item.actorId === actorId) ?? null;
  const credentials = (actorId: string): QingyuCredentials => {
    const session = storedSession(actorId);
    if (session === null)
      throw new QingyuError(401, "QINGYU_AUTH_REQUIRED", "请先使用轻语 APP 扫码登录");
    return session.credentials;
  };
  const removeSessionOnUnauthorized = async (actorId: string, error: unknown): Promise<never> => {
    if (error instanceof QingyuError && error.status === 401) {
      state = { ...state, sessions: state.sessions.filter((item) => item.actorId !== actorId) };
      await save();
    }
    throw error;
  };
  const publicSession = (actorId: string): QingyuPublicSession => {
    const session = storedSession(actorId);
    const login = loginChallenges.get(actorId);
    return {
      authenticated: session !== null,
      user: session?.credentials.user ?? null,
      login:
        login === undefined
          ? null
          : { status: login.status, qrContent: login.qrContent, expiresAt: login.expiresAt },
    };
  };
  const linkKey = (externalProjectId: string, defectId: string): string =>
    `${externalProjectId}\u001f${defectId}`;
  const linkForExternal = (
    externalProjectId: string,
    defectId: string,
  ): Promise<QingyuBugLink | null> => options.linkStore.getByExternal(externalProjectId, defectId);

  const uploadImage = async (
    actorId: string,
    clientSubmissionId: string,
    image: Awaited<ReturnType<QingyuClient["downloadImages"]>>["images"][number],
  ): Promise<string> => {
    const clientAttachmentId = randomUUID();
    const uploadAttempt = 1;
    const sha256 = createHash("sha256").update(image.bytes).digest("hex");
    const base = `submission:${clientSubmissionId}:attachment:${clientAttachmentId}:upload:${uploadAttempt}`;
    const initialized = await options.mobileAttachmentStore.initUpload({
      actorId,
      idempotencyKey: `${base}:init`,
      request: {
        submissionContractVersion: "1.1.0",
        projectId: options.qaProjectId,
        clientSubmissionId,
        clientAttachmentId,
        uploadAttempt,
        filename: image.filename,
        mediaType: image.mediaType,
        expectedSize: image.bytes.length,
        sha256,
      },
    });
    let version = initialized.version;
    let chunkNumber = 0;
    for (let offset = 0; offset < image.bytes.length; offset += initialized.chunkSize) {
      const bytes = image.bytes.subarray(
        offset,
        Math.min(image.bytes.length, offset + initialized.chunkSize),
      );
      const receipt = await options.mobileAttachmentStore.putChunk({
        actorId,
        idempotencyKey: `${base}:chunk:${chunkNumber}`,
        sessionId: initialized.sessionId,
        chunkNumber,
        expectedVersion: version,
        clientSubmissionId,
        clientAttachmentId,
        chunkSha256: createHash("sha256").update(bytes).digest("hex"),
        bytes,
      });
      version = receipt.version;
      chunkNumber += 1;
    }
    const finalized = await options.mobileAttachmentStore.finalizeUpload({
      actorId,
      idempotencyKey: `${base}:finalize`,
      sessionId: initialized.sessionId,
      request: {
        submissionContractVersion: "1.1.0",
        expectedVersion: version,
        clientSubmissionId,
        clientAttachmentId,
        uploadAttempt,
        sha256,
        expectedSize: image.bytes.length,
      },
    });
    if (!finalized.readyToBind)
      throw new QingyuError(
        409,
        "QINGYU_ATTACHMENT_NOT_READY",
        `轻语图片 ${image.filename} 未通过附件校验`,
      );
    await options.mobileAttachmentStore.bindAttachment({
      actorId,
      attachmentId: finalized.attachmentId,
      idempotencyKey: `submission:${clientSubmissionId}:attachment:${clientAttachmentId}:bind:1`,
      request: {
        submissionContractVersion: "1.1.0",
        expectedVersion: finalized.version,
        projectId: options.qaProjectId,
        clientSubmissionId,
        clientAttachmentId,
        leaseGeneration: 1,
        intent: "bug_create",
      },
    });
    return finalized.attachmentId;
  };

  const createPendingImport = async (
    actorId: string,
    externalProjectId: string,
    defect: QingyuDefect,
    sessionCredentials: QingyuCredentials,
  ): Promise<PendingImport> => {
    const key = linkKey(externalProjectId, defect.id);
    const clientSubmissionId = deterministicUuid(`qingyu-import\u001f${actorId}\u001f${key}`);
    const downloaded = await client.downloadImages(sessionCredentials, defect);
    const attachmentIds: string[] = [];
    for (const image of downloaded.images)
      attachmentIds.push(await uploadImage(actorId, clientSubmissionId, image));
    const qingyuTitle = defect.title.replace(/\s+/gu, " ").trim();
    const qingyuDescription = defect.description.replace(/\s+/gu, " ").trim();
    const content = `[轻语] ${[
      qingyuTitle,
      ...(qingyuDescription.length === 0 || qingyuDescription === qingyuTitle
        ? []
        : [qingyuDescription]),
    ].join(" ")}`;
    const request: MobileCreateBugRequest = {
      submissionContractVersion: "1.1.0",
      projectId: options.qaProjectId,
      clientSubmissionId,
      title: content.slice(0, 300),
      description: content.slice(0, 20_000),
      expectedBehavior: defect.expectedBehavior.slice(0, 10_000),
      severity: severity(defect.severity),
      priority: priority(defect.priority),
      ownerId: actorId,
      verificationOwnerId: actorId,
      occurrence: {
        observedAt: now().toISOString(),
        platform: "other",
        steps: defect.steps.map((step) => step.slice(0, 1_000)).slice(0, 50),
        actualBehavior: defect.actualBehavior.slice(0, 10_000),
        environment: { qaAppVersion: "qingyu-import" },
      },
      attachmentIds,
      captureBundleId: null,
    };
    const pending: PendingImport = {
      key,
      actorId,
      externalProjectId,
      defectId: defect.id,
      clientSubmissionId,
      request,
      defect,
      qingyuUser: sessionCredentials.user,
      skippedImages: downloaded.skipped,
      preparedAt: now().toISOString(),
    };
    state = {
      ...state,
      pendingImports: [...state.pendingImports.filter((item) => item.key !== key), pending],
    };
    await save();
    return pending;
  };

  const commitPendingImport = async (pending: PendingImport): Promise<QingyuImportItemResult> => {
    const creation = await options.mobileBugStore.createBug({
      actorId: pending.actorId,
      idempotencyKey: `submission:${pending.clientSubmissionId}:commit`,
      request: pending.request,
    });
    const importedAt = now().toISOString();
    const link: Omit<QingyuBugLink, "version"> = {
      bugId: creation.bug.id,
      qaProjectId: options.qaProjectId,
      externalProjectId: pending.externalProjectId,
      defectId: pending.defectId,
      defectCode: pending.defect.code,
      defectTitle: pending.defect.title,
      defectUrl: pending.defect.url,
      importedByActorId: pending.actorId,
      qingyuUserId: pending.qingyuUser.id,
      qingyuUserName: pending.qingyuUser.name,
      importedAt,
      syncStatus: "not_synced",
      syncAttempts: 0,
      syncedAt: null,
      externalStatus: pending.defect.status,
      lastSyncErrorCode: null,
      lastSyncErrorMessage: null,
      lastSyncAt: null,
    };
    await options.linkStore.put(link);
    state = {
      ...state,
      pendingImports: state.pendingImports.filter((item) => item.key !== pending.key),
    };
    await save();
    return {
      defectId: pending.defectId,
      status: creation.replayed ? "already_imported" : "created",
      bug: creation.bug,
      skippedImages: pending.skippedImages,
      errorCode: null,
      errorMessage: null,
    };
  };

  const importOne = async (
    actorId: string,
    externalProjectId: string,
    defectId: string,
    sessionCredentials: QingyuCredentials,
  ): Promise<QingyuImportItemResult> => {
    const existing = await linkForExternal(externalProjectId, defectId);
    if (existing !== null) {
      const bug = await options.mobileBugStore.getBug({ actorId, bugId: existing.bugId });
      return {
        defectId,
        status: "already_imported",
        bug,
        skippedImages: 0,
        errorCode: null,
        errorMessage: null,
      };
    }
    const pending = state.pendingImports.find(
      (item) => item.key === linkKey(externalProjectId, defectId),
    );
    const fresh = await client.getDefect(sessionCredentials, defectId);
    if (!isActionableQingyuDefect(fresh))
      return {
        defectId,
        status: "skipped_terminal",
        bug: null,
        skippedImages: 0,
        errorCode: null,
        errorMessage: null,
      };
    return commitPendingImport(
      pending ?? (await createPendingImport(actorId, externalProjectId, fresh, sessionCredentials)),
    );
  };

  return {
    session: publicSession,

    async startLogin(actorId) {
      return mutate(async () => {
        const challenge = await client.startLogin();
        loginChallenges.set(actorId, challenge);
        state = { ...state, sessions: state.sessions.filter((item) => item.actorId !== actorId) };
        await save();
        return publicSession(actorId);
      });
    },

    async pollLogin(actorId) {
      return mutate(async () => {
        const challenge = loginChallenges.get(actorId);
        if (challenge === undefined) return publicSession(actorId);
        const result = await client.pollLogin(challenge);
        if (result.challenge === null && result.credentials !== null) {
          loginChallenges.delete(actorId);
          const at = now().toISOString();
          state = {
            ...state,
            sessions: [
              ...state.sessions.filter((item) => item.actorId !== actorId),
              { actorId, credentials: result.credentials, connectedAt: at, lastUsedAt: at },
            ],
          };
          await save();
        } else if (result.challenge !== null) loginChallenges.set(actorId, result.challenge);
        return publicSession(actorId);
      });
    },

    async logout(actorId) {
      return mutate(async () => {
        loginChallenges.delete(actorId);
        state = { ...state, sessions: state.sessions.filter((item) => item.actorId !== actorId) };
        await save();
        return publicSession(actorId);
      });
    },

    async listProjects(actorId) {
      try {
        return await client.listProjects(credentials(actorId));
      } catch (error: unknown) {
        return removeSessionOnUnauthorized(actorId, error);
      }
    },

    async listOwnDefects(actorId, externalProjectId) {
      try {
        const result = await client.listOwnDefects(credentials(actorId), externalProjectId);
        return {
          total: result.total,
          defects: await Promise.all(
            result.defects.map(async (defect) => ({
              ...defect,
              actionable: isActionableQingyuDefect(defect),
              importedBugId: (await linkForExternal(externalProjectId, defect.id))?.bugId ?? null,
            })),
          ),
        };
      } catch (error: unknown) {
        return removeSessionOnUnauthorized(actorId, error);
      }
    },

    async importOwnDefects(actorId, externalProjectId, defectIds) {
      return mutate(async () => {
        const sessionCredentials = credentials(actorId);
        try {
          const selected =
            defectIds === undefined
              ? (
                  await client.listOwnDefects(sessionCredentials, externalProjectId, {
                    pageSize: 200,
                  })
                ).defects
                  .filter(isActionableQingyuDefect)
                  .map((item) => item.id)
              : [...new Set(defectIds)];
          const items: QingyuImportItemResult[] = [];
          for (const defectId of selected) {
            try {
              items.push(await importOne(actorId, externalProjectId, defectId, sessionCredentials));
            } catch (error: unknown) {
              if (error instanceof QingyuError && error.status === 401) throw error;
              const details = errorDetails(error);
              items.push({
                defectId,
                status: "failed",
                bug: null,
                skippedImages: 0,
                errorCode: details.code,
                errorMessage: details.message,
              });
            }
          }
          return { items };
        } catch (error: unknown) {
          return removeSessionOnUnauthorized(actorId, error);
        }
      });
    },

    getBugLink(bugId) {
      return options.linkStore.getBugLink(bugId);
    },

    async beforeHumanClose(actorId, bugId, syncOptions = {}) {
      return mutate(async () => {
        const link = await options.linkStore.getBugLink(bugId);
        if (link === null) return null;
        if (link.syncStatus === "succeeded" && syncOptions.verifyRemote !== true) {
          return { link, alreadyResolved: true };
        }
        const session =
          [storedSession(link.importedByActorId), storedSession(actorId)].find(
            (item) => item?.credentials.user.id === link.qingyuUserId,
          ) ?? null;
        if (session === null)
          throw new QingyuError(
            401,
            "QINGYU_LINKED_SESSION_REQUIRED",
            `请先用轻语账号“${link.qingyuUserName}”扫码连接，再关闭这个 Bug`,
          );
        const attemptAt = now().toISOString();
        const syncing = await options.linkStore.updateSync(link, {
          syncStatus: "syncing",
          syncAttempts: link.syncAttempts + 1,
          syncedAt: null,
          externalStatus: link.externalStatus,
          lastSyncErrorCode: null,
          lastSyncErrorMessage: null,
          lastSyncAt: attemptAt,
        });
        try {
          const result = await client.resolveDefect(session.credentials, {
            defectId: link.defectId,
            externalProjectId: link.externalProjectId,
            expectedUserId: link.qingyuUserId,
            expectedUserName: link.qingyuUserName,
          });
          const succeeded = await options.linkStore.updateSync(syncing, {
            syncStatus: "succeeded",
            syncAttempts: syncing.syncAttempts,
            syncedAt: now().toISOString(),
            externalStatus: result.status,
            lastSyncErrorCode: null,
            lastSyncErrorMessage: null,
            lastSyncAt: syncing.lastSyncAt,
          });
          return { link: succeeded, alreadyResolved: result.alreadyResolved };
        } catch (error: unknown) {
          const details = errorDetails(error);
          await options.linkStore.updateSync(syncing, {
            syncStatus: "failed",
            syncAttempts: syncing.syncAttempts,
            syncedAt: null,
            externalStatus: syncing.externalStatus,
            lastSyncErrorCode: details.code,
            lastSyncErrorMessage: details.message,
            lastSyncAt: syncing.lastSyncAt,
          });
          if (error instanceof QingyuError && error.status === 401)
            state = {
              ...state,
              sessions: state.sessions.filter((item) => item.actorId !== session.actorId),
            };
          await save();
          throw error;
        }
      });
    },
  };
}
