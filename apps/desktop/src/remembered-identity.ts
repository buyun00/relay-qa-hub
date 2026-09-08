import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DesktopBrowserSessionCookieStore } from "./network.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export class RememberedIdentityCommitError extends Error {
  readonly status: number;

  constructor(readonly code: "QA_HUB_IDENTITY_PERSIST_FAILED" | "QA_HUB_SESSION_CHANGED") {
    super(
      code === "QA_HUB_IDENTITY_PERSIST_FAILED"
        ? "The server processed the identity change, but this device could not save it. Login or logout is not durably complete."
        : "The active QA Hub identity or project changed before local persistence completed",
    );
    this.name = "RememberedIdentityCommitError";
    this.status = code === "QA_HUB_IDENTITY_PERSIST_FAILED" ? 503 : 409;
  }
}

export async function commitRememberedIdentity(
  session: DesktopBrowserSessionCookieStore,
  persist: () => void | Promise<void>,
): Promise<void> {
  const epoch = session.scopeEpoch();
  const isCurrent = () => epoch === session.scopeEpoch();
  try {
    await persist();
  } catch {
    throw new RememberedIdentityCommitError(
      isCurrent() ? "QA_HUB_IDENTITY_PERSIST_FAILED" : "QA_HUB_SESSION_CHANGED",
    );
  }
  if (!isCurrent()) throw new RememberedIdentityCommitError("QA_HUB_SESSION_CHANGED");
}

export async function persistRendererAuthenticationResponse(
  response: Response,
  session: DesktopBrowserSessionCookieStore,
  persist: () => void | Promise<void>,
): Promise<Response> {
  try {
    await commitRememberedIdentity(session, persist);
    return response;
  } catch (error) {
    if (!(error instanceof RememberedIdentityCommitError)) throw error;
    return new Response(JSON.stringify({ code: error.code, message: error.message }), {
      status: error.status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
}

export interface RememberedIdentityFileSystem {
  readFile(filePath: string, encoding: "utf8"): Promise<string>;
  mkdir(directory: string, options: { recursive: true }): Promise<unknown>;
  writeFile(
    filePath: string,
    contents: string,
    options: { encoding: "utf8"; mode: number; flag: "wx" },
  ): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  rm(filePath: string, options: { force: true }): Promise<void>;
}

function validatedIdentity(value: unknown, serviceOrigin: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("IDENTITY_FILE_INVALID");
  }
  const record = value as Record<string, unknown>;
  const loginName = record["loginName"];
  const projectId = record["projectId"];
  const userId = record["userId"];
  const identity = record["identity"];
  if (
    record["schemaVersion"] !== 2 ||
    record["serviceOrigin"] !== serviceOrigin ||
    typeof loginName !== "string" ||
    loginName.trim().length === 0 ||
    loginName.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(loginName) ||
    typeof userId !== "string" ||
    !UUID_PATTERN.test(userId) ||
    (identity !== "employee" && identity !== "gm") ||
    (!(typeof projectId === "string" && UUID_PATTERN.test(projectId)) &&
      !(identity === "gm" && projectId === null))
  ) {
    throw new Error("IDENTITY_FILE_INVALID");
  }
  // Only these fields may restore the principal. In particular, an unrelated
  // persisted isGm property must not override the validated identity type.
  return { displayName: loginName, projectId, userId, identity };
}

export class RememberedIdentityStore {
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string | null,
    private readonly serviceOrigin: string,
    private readonly session: DesktopBrowserSessionCookieStore,
    private readonly fileSystem: RememberedIdentityFileSystem = fs,
  ) {}

  async load(): Promise<void> {
    if (this.filePath === null) return;
    const generation = this.generation;
    const epoch = this.session.scopeEpoch();
    const raw = await this.fileSystem.readFile(this.filePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > 4_096) throw new Error("IDENTITY_FILE_TOO_LARGE");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("IDENTITY_FILE_INVALID");
    }
    const principal = validatedIdentity(parsed, this.serviceOrigin);
    if (generation !== this.generation || epoch !== this.session.scopeEpoch()) return;
    this.session.rememberPrincipal(principal);
  }

  persist(): Promise<void> {
    if (this.filePath === null) return Promise.resolve();
    const filePath = this.filePath;
    const generation = ++this.generation;
    const epoch = this.session.scopeEpoch();
    const snapshot = this.session.snapshot();
    // Capture the entire record before any asynchronous filesystem operation.
    const record = {
      schemaVersion: 2,
      serviceOrigin: this.serviceOrigin,
      loginName: this.session.rememberedLoginName(),
      projectId: this.session.rememberedProjectId(),
      userId: this.session.rememberedUserId(),
      identity: this.session.rememberedIdentity(),
    };
    const isCurrent = () =>
      generation === this.generation &&
      epoch === this.session.scopeEpoch() &&
      snapshot === this.session.snapshot();
    const operation = this.pending
      .catch(() => undefined)
      .then(async () => {
        if (!isCurrent()) return;
        if (record.loginName === null) {
          await this.fileSystem.rm(filePath, { force: true });
          return;
        }
        validatedIdentity(record, this.serviceOrigin);
        await this.fileSystem.mkdir(path.dirname(filePath), { recursive: true });
        if (!isCurrent()) return;
        const temporaryPath = `${filePath}.pending-${randomUUID()}`;
        try {
          await this.fileSystem.writeFile(temporaryPath, `${JSON.stringify(record)}\n`, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
          });
          if (!isCurrent()) return;
          await this.fileSystem.rename(temporaryPath, filePath);
        } finally {
          await this.fileSystem.rm(temporaryPath, { force: true });
        }
      });
    // A later logout waits for an already-started rename before deleting it.
    // Failed operations must not poison subsequent login or logout writes.
    this.pending = operation;
    return (async () => {
      await operation;
      let observed = operation;
      // A newer save of the same identity may have replaced this generation
      // before it ran. Its caller still needs a durable commit before success.
      while (
        epoch === this.session.scopeEpoch() &&
        snapshot === this.session.snapshot() &&
        observed !== this.pending
      ) {
        observed = this.pending;
        await observed;
      }
    })();
  }
}
