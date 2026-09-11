import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
} from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  ProjectComponentKey,
  ProjectComponentList,
  ProjectManagementInput,
  ProjectOnboardingRecord,
  ProjectRecord,
  SqliteStorageWorker,
} from "@relay-qa-hub/storage";
import {
  QaLoginDirectory,
  normalizeQaLoginName,
  qaLoginEmail,
  qaUserId,
  type QaUserIdentity,
} from "./people-config.js";
import type { BrowserAuthPrincipal } from "./browser-auth.js";

export interface ProjectManagementOptions {
  readonly worker: SqliteStorageWorker;
  readonly accountId: string;
  readonly gmUserId: string;
  readonly identities?: readonly QaUserIdentity[];
  readonly onboardingSecret?: string;
  readonly publicWebBaseUrl?: string;
  readonly now?: () => Date;
}
export class ProjectManagementService {
  private static readonly MAX_FAILED_JOIN_KEYS = 5_000;
  private readonly componentListeners = new Set<(projectId: string) => Promise<void>>();
  private readonly failedJoins = new Map<
    string,
    { count: number; firstAt: number; blockedUntil: number }
  >();
  constructor(readonly options: ProjectManagementOptions) {}
  private onboardingKey(): Buffer {
    if (!this.options.onboardingSecret || this.options.onboardingSecret.length < 32)
      throw new Error("project onboarding secret is not configured");
    return createHash("sha256").update(this.options.onboardingSecret, "utf8").digest();
  }
  private secretDigest(domain: string, value: string): string {
    return createHmac("sha256", this.onboardingKey())
      .update(`${domain}\0${value}`, "utf8")
      .digest("hex");
  }
  private seal(domain: string, value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.onboardingKey(), iv);
    cipher.setAAD(Buffer.from(`qa-hub:${domain}:v1`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [
      "v1",
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");
  }
  private open(domain: string, value: string | null): string | null {
    if (value === null) return null;
    const [version, iv, tag, ciphertext, ...extra] = value.split(".");
    if (version !== "v1" || !iv || !tag || ciphertext === undefined || extra.length > 0)
      throw new Error("project onboarding ciphertext is invalid");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.onboardingKey(),
      Buffer.from(iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(`qa-hub:${domain}:v1`, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
  private initializationLink(tokenCiphertext: string | null): string | null {
    const token = this.open("initialization-token", tokenCiphertext);
    if (!token || !this.options.publicWebBaseUrl) return null;
    return `${this.options.publicWebBaseUrl.replace(/\/$/u, "")}/#initialize=${encodeURIComponent(token)}`;
  }
  private publicOnboarding(record: ProjectOnboardingRecord, includeSecrets: boolean) {
    return {
      id: record.id,
      key: record.key,
      name: record.name,
      active: record.active,
      version: record.version,
      initializationStatus: record.initializationStatus,
      joinName: record.joinName,
      joinCodeVersion: record.joinCodeVersion,
      initializationTokenStatus: record.initializationTokenStatus,
      initializationIssuedAt: record.initializationIssuedAt,
      initializationUsedAt: record.initializationUsedAt,
      onboardingVersion: record.onboardingVersion,
      logo:
        record.logo === null
          ? null
          : {
              mediaType: record.logo.mediaType,
              sha256: record.logo.sha256,
              size: record.logo.bytes.byteLength,
            },
      ...(includeSecrets
        ? {
            joinCode: this.open("join-code", record.joinCodeCiphertext),
            initializationLink:
              record.initializationTokenStatus === "issued"
                ? this.initializationLink(record.initializationTokenCiphertext)
                : null,
          }
        : {}),
    };
  }
  private principal(actor: BrowserAuthPrincipal) {
    if (actor.accountId !== this.options.accountId)
      throw Object.assign(new Error("project is not accessible"), {
        code: "PROJECT_NOT_ACCESSIBLE",
      });
    return {
      accountId: this.options.accountId,
      actorId: actor.userId,
      isGm: actor.isGm === true && actor.userId === this.options.gmUserId,
    };
  }
  async entry(projectId: string): Promise<ProjectRecord> {
    return this.options.worker.projectManagement({
      operation: "entry",
      accountId: this.options.accountId,
      actorId: this.options.gmUserId,
      ...(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(projectId)
        ? { projectId }
        : { key: projectId.trim().toUpperCase() }),
    });
  }
  async login(
    name: string,
    projectId: string,
    timestamp: string,
  ): Promise<{ userId: string; projectId: string }> {
    const users = await this.options.worker.projectManagement<readonly QaUserIdentity[]>({
      operation: "loginIdentities",
      accountId: this.options.accountId,
      actorId: this.options.gmUserId,
    });
    const directory = new QaLoginDirectory([...users, ...(this.options.identities ?? [])]);
    const normalized = normalizeQaLoginName(name);
    const resolved = directory.resolveLogin(normalized.displayName);
    const userId = resolved?.id ?? qaUserId(this.options.accountId, normalized.displayName);
    // A familiar GM display name is never a way around its separate password.
    if (userId === this.options.gmUserId)
      throw Object.assign(new Error("GM requires its management password"), {
        code: "GM_PASSWORD_REQUIRED",
      });
    return this.options.worker.projectManagement({
      operation: "login",
      accountId: this.options.accountId,
      actorId: userId,
      userId,
      projectId,
      displayName: resolved?.displayName ?? normalized.displayName,
      email: qaLoginEmail(this.options.accountId, resolved?.displayName ?? normalized.displayName),
      now: timestamp,
    });
  }
  async createOnboarding(actor: BrowserAuthPrincipal): Promise<unknown> {
    this.principal(actor);
    const projectId = randomUUID();
    const key = `P${projectId.replaceAll("-", "").slice(0, 8).toUpperCase()}`;
    const joinCode = randomInt(0, 10_000).toString().padStart(4, "0");
    const token = randomBytes(32).toString("base64url");
    const record = await this.execute<ProjectOnboardingRecord>(actor, {
      operation: "createOnboarding",
      projectId,
      key,
      name: `待初始化 ${key}`,
      joinCodeDigest: this.secretDigest("join-code", joinCode),
      joinCodeCiphertext: this.seal("join-code", joinCode),
      initializationTokenDigest: this.secretDigest("initialization-token", token),
      initializationTokenCiphertext: this.seal("initialization-token", token),
    });
    return this.publicOnboarding(record, true);
  }
  async listOnboarding(actor: BrowserAuthPrincipal): Promise<{ items: unknown[] }> {
    const response = await this.execute<{ items: ProjectOnboardingRecord[] }>(actor, {
      operation: "onboardingAdmin",
    });
    return { items: response.items.map((item) => this.publicOnboarding(item, true)) };
  }
  async logo(actor: BrowserAuthPrincipal, projectId: string) {
    return this.options.worker.projectManagement<{
      mediaType: "image/png" | "image/jpeg" | "image/webp";
      sha256: string;
      bytes: Uint8Array;
    }>({
      operation: "projectLogo",
      ...this.principal(actor),
      projectId,
    });
  }
  async inspectInitialization(token: string): Promise<unknown> {
    const record = await this.options.worker.projectManagement<ProjectOnboardingRecord>({
      operation: "inspectInitialization",
      accountId: this.options.accountId,
      actorId: this.options.gmUserId,
      initializationTokenDigest: this.secretDigest("initialization-token", token),
    });
    return this.publicOnboarding(record, true);
  }
  async initializeProject(
    token: string,
    input: {
      readonly name: string;
      readonly initialMembers: readonly string[];
      readonly logo?: { readonly mediaType: string; readonly dataBase64: string } | null;
    },
  ): Promise<unknown> {
    const projectName = normalizeProjectJoinName(input.name);
    if (input.initialMembers.length > 500) throw new TypeError("too many initial members");
    const members = new Map<string, { displayName: string; nameKey: string }>();
    for (const value of input.initialMembers) {
      const member = normalizeProjectMemberName(value);
      members.set(member.key, { displayName: member.displayName, nameKey: member.key });
    }
    const logo = parseProjectLogo(input.logo);
    const initialMembers = [...members.values()].map((member) => {
      const userId = projectScopedUserId(this.options.accountId, projectName.key, member.nameKey);
      return {
        userId,
        nameKey: member.nameKey,
        displayName: member.displayName,
        email: `project-${userId.replaceAll("-", "")}@local.invalid`,
      };
    });
    const submissionDigest = createHash("sha256")
      .update(
        JSON.stringify({
          name: projectName.displayName,
          nameKey: projectName.key,
          initialMembers: initialMembers.map(({ nameKey, displayName }) => ({
            nameKey,
            displayName,
          })),
          logo: logo ? { mediaType: logo.mediaType, sha256: logo.sha256 } : null,
        }),
      )
      .digest("hex");
    const record = await this.options.worker.projectManagement<ProjectOnboardingRecord>({
      operation: "initializeProject",
      accountId: this.options.accountId,
      actorId: this.options.gmUserId,
      initializationTokenDigest: this.secretDigest("initialization-token", token),
      submissionDigest,
      name: projectName.displayName,
      nameKey: projectName.key,
      initialMembers,
      logo,
      now: (this.options.now?.() ?? new Date()).toISOString(),
    });
    return this.publicOnboarding(record, true);
  }
  async joinWithCode(
    name: string,
    projectName: string,
    joinCode: string,
    timestamp: string,
    clientKey: string,
  ): Promise<{ userId: string; projectId: string }> {
    const project = normalizeProjectJoinName(projectName);
    const member = normalizeProjectMemberName(name);
    if (!/^\d{4}$/u.test(joinCode))
      throw Object.assign(new Error("项目名称或验证码不正确"), { code: "AUTHENTICATION_FAILED" });
    const limiterKey = this.secretDigest("join-rate", `${clientKey}\0${project.key}`);
    const nowMs = Date.parse(timestamp);
    for (const [key, value] of this.failedJoins) {
      if (value.blockedUntil <= nowMs && nowMs - value.firstAt > 60_000)
        this.failedJoins.delete(key);
    }
    if (
      !this.failedJoins.has(limiterKey) &&
      this.failedJoins.size >= ProjectManagementService.MAX_FAILED_JOIN_KEYS
    ) {
      const oldest = [...this.failedJoins.entries()].sort(
        ([, left], [, right]) => left.firstAt - right.firstAt,
      )[0];
      if (oldest) this.failedJoins.delete(oldest[0]);
    }
    const attempt = this.failedJoins.get(limiterKey);
    if (attempt && attempt.blockedUntil > nowMs)
      throw Object.assign(new Error("尝试次数过多，请稍后重试"), {
        code: "RATE_LIMITED",
        retryAfterSeconds: Math.max(1, Math.ceil((attempt.blockedUntil - nowMs) / 1_000)),
      });
    const userId = projectScopedUserId(this.options.accountId, project.key, member.key);
    try {
      const result = await this.options.worker.projectManagement<{
        userId: string;
        projectId: string;
      }>({
        operation: "joinByCode",
        accountId: this.options.accountId,
        actorId: userId,
        userId,
        name: project.displayName,
        nameKey: project.key,
        memberNameKey: member.key,
        displayName: member.displayName,
        email: `project-${userId.replaceAll("-", "")}@local.invalid`,
        joinCodeDigest: this.secretDigest("join-code", joinCode),
        now: timestamp,
      });
      this.failedJoins.delete(limiterKey);
      return result;
    } catch (error) {
      if ((error as { code?: string }).code === "AUTHENTICATION_FAILED") {
        const recent = attempt && nowMs - attempt.firstAt <= 60_000 ? attempt : undefined;
        const count = (recent?.count ?? 0) + 1;
        this.failedJoins.set(limiterKey, {
          count,
          firstAt: recent?.firstAt ?? nowMs,
          blockedUntil: count >= 5 ? nowMs + 30_000 : nowMs,
        });
      }
      throw error;
    }
  }
  async resetJoinCode(actor: BrowserAuthPrincipal, projectId: string): Promise<unknown> {
    const code = randomInt(0, 10_000).toString().padStart(4, "0");
    const record = await this.execute<ProjectOnboardingRecord>(actor, {
      operation: "resetJoinCode",
      projectId,
      joinCodeDigest: this.secretDigest("join-code", code),
      joinCodeCiphertext: this.seal("join-code", code),
    });
    return this.publicOnboarding(record, true);
  }
  async rotateInitializationLink(actor: BrowserAuthPrincipal, projectId: string): Promise<unknown> {
    const current = await this.execute<ProjectOnboardingRecord>(actor, {
      operation: "onboardingAdmin",
      projectId,
    });
    const token = randomBytes(32).toString("base64url");
    const needsCode = current.joinCodeCiphertext === null;
    const code = needsCode ? randomInt(0, 10_000).toString().padStart(4, "0") : null;
    const record = await this.execute<ProjectOnboardingRecord>(actor, {
      operation: "rotateInitializationToken",
      projectId,
      initializationTokenDigest: this.secretDigest("initialization-token", token),
      initializationTokenCiphertext: this.seal("initialization-token", token),
      ...(code === null
        ? {}
        : {
            joinCodeDigest: this.secretDigest("join-code", code),
            joinCodeCiphertext: this.seal("join-code", code),
          }),
    });
    return this.publicOnboarding(record, true);
  }
  async revokeInitializationLink(actor: BrowserAuthPrincipal, projectId: string): Promise<unknown> {
    const record = await this.execute<ProjectOnboardingRecord>(actor, {
      operation: "revokeInitializationToken",
      projectId,
    });
    return this.publicOnboarding(record, true);
  }
  async execute<T = unknown>(
    actor: BrowserAuthPrincipal,
    input: Omit<ProjectManagementInput, "accountId" | "actorId" | "isGm" | "now">,
  ): Promise<T> {
    const result = await this.options.worker.projectManagement<T>({
      ...input,
      ...this.principal(actor),
      now: (this.options.now?.() ?? new Date()).toISOString(),
    });
    if (input.operation === "setComponent" && input.projectId)
      for (const listener of this.componentListeners) await listener(input.projectId);
    return result;
  }
  onComponentChanged(listener: (projectId: string) => Promise<void>): () => void {
    this.componentListeners.add(listener);
    return () => this.componentListeners.delete(listener);
  }
  async components(actor: BrowserAuthPrincipal, projectId: string): Promise<ProjectComponentList> {
    const response = await this.execute<ProjectComponentList>(actor, {
      operation: "components",
      projectId,
      includePrivateConfig: actor.isGm === true && actor.userId === this.options.gmUserId,
    });
    const redact = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(redact)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .filter(([key]) => !/password|token|authorization|secret/iu.test(key))
                .map(([key, item]) => [key, redact(item)]),
            )
          : value;
    return {
      ...response,
      items: response.items.map((item) => ({
        ...item,
        config: redact(item.config) as Record<string, unknown>,
      })),
    };
  }
  async assertComponent(
    actor: BrowserAuthPrincipal,
    projectId: string,
    componentKey: ProjectComponentKey,
  ): Promise<void> {
    const components = await this.components(actor, projectId);
    const component = components.items.find((item) => item.key === componentKey);
    if (!component?.enabled)
      throw Object.assign(new Error("该项目未启用此组件"), { code: "COMPONENT_DISABLED" });
    if (component.status !== "ready")
      throw Object.assign(new Error("该组件待配置"), { code: "COMPONENT_NOT_CONFIGURED" });
  }
}

export function normalizeProjectJoinName(value: string): { displayName: string; key: string } {
  if (typeof value !== "string") throw new TypeError("project name is invalid");
  const displayName = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (displayName.length < 1 || displayName.length > 200)
    throw new TypeError("project name is invalid");
  return { displayName, key: displayName.toLowerCase() };
}

export function normalizeProjectMemberName(value: string): { displayName: string; key: string } {
  if (typeof value !== "string") throw new TypeError("member name is invalid");
  const displayName = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (displayName.length < 1 || displayName.length > 100)
    throw new TypeError("member name is invalid");
  return { displayName, key: displayName.toLowerCase() };
}

export function projectScopedUserId(
  accountId: string,
  projectNameKey: string,
  memberNameKey: string,
): string {
  const digest = createHash("sha256")
    .update(`qa-hub-project-user:${accountId}:${projectNameKey}:${memberNameKey}`)
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function parseProjectLogo(
  value: { readonly mediaType: string; readonly dataBase64: string } | null | undefined,
): {
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  sha256: string;
  bytes: Uint8Array;
} | null {
  if (value === undefined || value === null) return null;
  if (!["image/png", "image/jpeg", "image/webp"].includes(value.mediaType))
    throw new TypeError("logo media type is invalid");
  if (
    typeof value.dataBase64 !== "string" ||
    value.dataBase64.length > 700_000 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value.dataBase64)
  )
    throw new TypeError("logo data is invalid");
  const bytes = Buffer.from(value.dataBase64, "base64");
  if (bytes.byteLength < 1 || bytes.byteLength > 524_288)
    throw new TypeError("logo size is invalid");
  const png =
    bytes.byteLength >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp =
    bytes.byteLength >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (
    (value.mediaType === "image/png" && !png) ||
    (value.mediaType === "image/jpeg" && !jpeg) ||
    (value.mediaType === "image/webp" && !webp)
  )
    throw new TypeError("logo signature does not match media type");
  return {
    mediaType: value.mediaType as "image/png" | "image/jpeg" | "image/webp",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes,
  };
}
function body(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body))
    throw new TypeError("request body must be an object");
  return request.body as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("text is required");
  return value.trim();
}
function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError("expectedVersion is required");
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError("boolean is required");
  return value;
}
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 500 || value.some((item) => typeof item !== "string"))
    throw new TypeError("initialMembers must be an array of strings");
  return value as string[];
}
function initializationToken(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value))
    throw new TypeError("initialization token is invalid");
  return value;
}
function errorReply(reply: FastifyReply, error: unknown): FastifyReply {
  const candidate = error as { code?: string; message?: string };
  const code =
    error instanceof TypeError ? "INVALID_REQUEST" : (candidate.code ?? "INTERNAL_ERROR");
  const status =
    code === "NOT_FOUND"
      ? 404
      : code === "INITIALIZATION_LINK_INVALID"
        ? 404
        : code === "UNAUTHENTICATED"
          ? 401
          : ["FORBIDDEN", "PROJECT_NOT_ACCESSIBLE", "PROJECT_MEMBERSHIP_DISABLED"].includes(code)
            ? 403
            : [
                  "VERSION_CONFLICT",
                  "COMPONENT_DEPENDENCY_REQUIRED",
                  "PROJECT_NAME_CONFLICT",
                  "INITIALIZATION_ALREADY_COMPLETED",
                ].includes(code)
              ? 409
              : code === "INTERNAL_ERROR"
                ? 500
                : 400;
  return reply.code(status).send({
    code,
    message: status === 500 ? "project operation failed" : (candidate.message ?? code),
  });
}
export function registerProjectManagementRoutes(
  app: FastifyInstance,
  service: ProjectManagementService,
  resolveActor: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<BrowserAuthPrincipal | undefined>,
): void {
  const guarded =
    (
      handler: (
        actor: BrowserAuthPrincipal,
        request: FastifyRequest,
        reply: FastifyReply,
      ) => Promise<unknown>,
    ) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const actor = await resolveActor(request, reply);
        if (!actor) return reply.sent ? reply : reply.code(401).send({ code: "UNAUTHENTICATED" });
        return await handler(actor, request, reply);
      } catch (error) {
        return errorReply(reply, error);
      }
    };
  const params = (request: FastifyRequest) =>
    request.params as { projectId: string; userId?: string; componentKey?: ProjectComponentKey };
  const gm = (actor: BrowserAuthPrincipal) => {
    if (!actor.isGm || actor.userId !== service.options.gmUserId)
      throw Object.assign(new Error("GM login is required"), { code: "FORBIDDEN" });
  };
  app.get("/api/v1/project-entry/:projectId", async (request, reply) => {
    try {
      if (service.options.onboardingSecret) return reply.code(404).send({ code: "NOT_FOUND" });
      return await service.entry(params(request).projectId);
    } catch (error) {
      return errorReply(reply, error);
    }
  });
  app.post("/api/v1/project-initialization/inspect", async (request, reply) => {
    try {
      const input = body(request);
      return await service.inspectInitialization(initializationToken(input["token"]));
    } catch (error) {
      return errorReply(reply, error);
    }
  });
  app.post("/api/v1/project-initialization/complete", async (request, reply) => {
    try {
      const input = body(request);
      const logoValue = input["logo"];
      let logo: { mediaType: string; dataBase64: string } | null | undefined;
      if (logoValue === null) logo = null;
      else if (logoValue !== undefined) {
        if (typeof logoValue !== "object" || Array.isArray(logoValue))
          throw new TypeError("logo must be an object or null");
        const record = logoValue as Record<string, unknown>;
        logo = {
          mediaType: text(record["mediaType"]),
          dataBase64: text(record["dataBase64"]),
        };
      }
      return await service.initializeProject(initializationToken(input["token"]), {
        name: text(input["name"]),
        initialMembers: stringArray(input["initialMembers"]),
        ...(logo === undefined ? {} : { logo }),
      });
    } catch (error) {
      return errorReply(reply, error);
    }
  });
  app.get(
    "/api/v1/gm/projects",
    guarded(async (actor) => {
      gm(actor);
      return service.options.onboardingSecret
        ? service.listOnboarding(actor)
        : service.execute(actor, { operation: "list" });
    }),
  );
  app.post(
    "/api/v1/gm/projects",
    guarded(async (actor, request) => {
      gm(actor);
      const input = body(request);
      return service.options.onboardingSecret
        ? service.createOnboarding(actor)
        : service.execute(actor, {
            operation: "create",
            projectId: input["id"] === undefined ? randomUUID() : text(input["id"]),
            key: text(input["key"]),
            name: text(input["name"]),
          });
    }),
  );
  app.post(
    "/api/v1/gm/projects/:projectId/join-code/reset",
    guarded(async (actor, request) => {
      gm(actor);
      return service.resetJoinCode(actor, params(request).projectId);
    }),
  );
  app.post(
    "/api/v1/gm/projects/:projectId/initialization-link/rotate",
    guarded(async (actor, request) => {
      gm(actor);
      return service.rotateInitializationLink(actor, params(request).projectId);
    }),
  );
  app.post(
    "/api/v1/gm/projects/:projectId/initialization-link/revoke",
    guarded(async (actor, request) => {
      gm(actor);
      return service.revokeInitializationLink(actor, params(request).projectId);
    }),
  );
  app.patch(
    "/api/v1/gm/projects/:projectId",
    guarded(async (actor, request) => {
      gm(actor);
      const input = body(request);
      const renamed =
        input["name"] === undefined ? undefined : normalizeProjectJoinName(text(input["name"]));
      return service.execute(actor, {
        operation: "update",
        projectId: params(request).projectId,
        expectedVersion: version(input["expectedVersion"]),
        ...(renamed === undefined ? {} : { name: renamed.displayName, nameKey: renamed.key }),
        ...(input["active"] === undefined ? {} : { active: boolean(input["active"]) }),
      });
    }),
  );
  app.get(
    "/api/v1/projects/:projectId/components",
    guarded((actor, request) => service.components(actor, params(request).projectId)),
  );
  app.get(
    "/api/v1/projects/:projectId/logo",
    guarded(async (actor, request, reply) => {
      const logo = await service.logo(actor, params(request).projectId);
      return reply
        .header("cache-control", "private, max-age=300")
        .header("etag", `"${logo.sha256}"`)
        .type(logo.mediaType)
        .send(Buffer.from(logo.bytes));
    }),
  );
  app.put(
    "/api/v1/projects/:projectId/components/:componentKey",
    guarded(async (actor, request) => {
      gm(actor);
      const input = body(request);
      const config = input["config"];
      if (!config || typeof config !== "object" || Array.isArray(config))
        throw new TypeError("config must be an object");
      return service.execute(actor, {
        operation: "setComponent",
        projectId: params(request).projectId,
        componentKey: params(request).componentKey!,
        enabled: boolean(input["enabled"]),
        expectedVersion: version(input["expectedVersion"]),
        config: config as Record<string, unknown>,
      });
    }),
  );
  const membership = (gmOnly: boolean) =>
    guarded(async (actor, request) => {
      if (gmOnly) gm(actor);
      const input = body(request);
      return service.execute(actor, {
        operation: "membership",
        projectId: params(request).projectId,
        userId: params(request).userId!,
        active: boolean(input["active"]),
        expectedVersion: version(input["expectedVersion"]),
      });
    });
  app.put("/api/v1/gm/projects/:projectId/members/:userId", membership(true));
  app.patch("/api/v1/projects/:projectId/members/:userId", membership(false));
  app.get(
    "/api/v1/projects/:projectId/management-events",
    guarded((actor, request) =>
      service.execute(actor, { operation: "audit", projectId: params(request).projectId }),
    ),
  );
}
