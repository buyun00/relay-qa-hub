import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  ProjectComponentKey,
  ProjectComponentList,
  ProjectManagementInput,
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
  readonly now?: () => Date;
}
export class ProjectManagementService {
  private readonly componentListeners = new Set<(projectId: string) => Promise<void>>();
  constructor(readonly options: ProjectManagementOptions) {}
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
function errorReply(reply: FastifyReply, error: unknown): FastifyReply {
  const candidate = error as { code?: string; message?: string };
  const code =
    error instanceof TypeError ? "INVALID_REQUEST" : (candidate.code ?? "INTERNAL_ERROR");
  const status =
    code === "NOT_FOUND"
      ? 404
      : code === "UNAUTHENTICATED"
        ? 401
        : ["FORBIDDEN", "PROJECT_NOT_ACCESSIBLE", "PROJECT_MEMBERSHIP_DISABLED"].includes(code)
          ? 403
          : ["VERSION_CONFLICT", "COMPONENT_DEPENDENCY_REQUIRED"].includes(code)
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
    (handler: (actor: BrowserAuthPrincipal, request: FastifyRequest) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const actor = await resolveActor(request, reply);
        if (!actor) return reply.sent ? reply : reply.code(401).send({ code: "UNAUTHENTICATED" });
        return await handler(actor, request);
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
      return await service.entry(params(request).projectId);
    } catch (error) {
      return errorReply(reply, error);
    }
  });
  app.get(
    "/api/v1/gm/projects",
    guarded(async (actor) => {
      gm(actor);
      return service.execute(actor, { operation: "list" });
    }),
  );
  app.post(
    "/api/v1/gm/projects",
    guarded(async (actor, request) => {
      gm(actor);
      const input = body(request);
      return service.execute(actor, {
        operation: "create",
        projectId: input["id"] === undefined ? randomUUID() : text(input["id"]),
        key: text(input["key"]),
        name: text(input["name"]),
      });
    }),
  );
  app.patch(
    "/api/v1/gm/projects/:projectId",
    guarded(async (actor, request) => {
      gm(actor);
      const input = body(request);
      return service.execute(actor, {
        operation: "update",
        projectId: params(request).projectId,
        expectedVersion: version(input["expectedVersion"]),
        ...(input["name"] === undefined ? {} : { name: text(input["name"]) }),
        ...(input["active"] === undefined ? {} : { active: boolean(input["active"]) }),
      });
    }),
  );
  app.get(
    "/api/v1/projects/:projectId/components",
    guarded((actor, request) => service.components(actor, params(request).projectId)),
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
