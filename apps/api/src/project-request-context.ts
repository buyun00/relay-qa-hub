import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { MobileScopeBootstrap } from "@relay-qa-hub/storage";
import { getBrowserPrincipal } from "./browser-auth.js";
import type { ProjectManagementService } from "./project-management.js";

interface RequestProject {
  projectId?: string;
  gm?: Readonly<{ accountId: string; projectId: string; actorId: string }>;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A context belongs to one HTTP invocation, never to a user or a running client. */
export class ProjectRequestContext {
  private readonly storage = new AsyncLocalStorage<RequestProject>();
  currentProjectId(): string {
    const projectId = this.storage.getStore()?.projectId;
    if (!projectId) throw Object.assign(new Error("请选择项目"), { code: "PROJECT_REQUIRED" });
    return projectId;
  }

  runInProject<T>(projectId: string, work: () => T): T {
    return this.storage.run({ projectId }, work);
  }

  scope(legacy: MobileScopeBootstrap): MobileScopeBootstrap {
    const storage = this.storage;
    return Object.freeze({
      ...legacy,
      get projectId() {
        const projectId = storage.getStore()?.projectId;
        if (!projectId) throw Object.assign(new Error("请选择项目"), { code: "PROJECT_REQUIRED" });
        return projectId;
      },
    });
  }

  register(app: FastifyInstance, service: ProjectManagementService): void {
    app.addHook("onRequest", (_request, _reply, done) => {
      const context: RequestProject = {};
      this.storage.run(context, () =>
        service.options.worker.runWithRequestAuthorization(context, done),
      );
    });
    app.addHook("preHandler", async (request, reply) => {
      const path = request.url.split("?")[0]!;
      if (path === "/api/v1/mcp/tools") return;
      if (
        !path.startsWith("/api/v1/") ||
        path.startsWith("/api/v1/health/") ||
        path.startsWith("/api/v1/auth/") ||
        path.startsWith("/api/v1/project-entry/") ||
        path.startsWith("/api/v1/updates/")
      )
        return;
      const principal = getBrowserPrincipal(request);
      if (!principal) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      if (
        path === "/api/v1/projects" ||
        path === "/api/v1/bug-actions" ||
        path.startsWith("/api/v1/mcp/") ||
        path.startsWith("/api/v1/gm/")
      )
        return;
      try {
        const projectId = await this.resolve(request, service);
        await service.execute(principal, { operation: "authorize", projectId });
        const context = this.storage.getStore();
        if (!context) throw new Error("PROJECT_REQUEST_CONTEXT_MISSING");
        context.projectId = projectId;
        if (
          principal.isGm === true &&
          principal.userId === service.options.gmUserId &&
          principal.accountId === service.options.accountId
        ) {
          context.gm = Object.freeze({
            accountId: principal.accountId,
            projectId,
            actorId: principal.userId,
          });
        }
      } catch (error) {
        const code = (error as { code?: string }).code ?? "INTERNAL_ERROR";
        return reply
          .code(
            code === "NOT_FOUND"
              ? 404
              : code === "PROJECT_NOT_ACCESSIBLE"
                ? 403
                : code === "PROJECT_REQUIRED" || code === "PROJECT_MISMATCH"
                  ? 400
                  : 500,
          )
          .send({ code });
      }
    });
  }

  private async resolve(
    request: FastifyRequest,
    service: ProjectManagementService,
  ): Promise<string> {
    const principal = getBrowserPrincipal(request)!;
    const params = record(request.params);
    const candidates = [
      params["projectId"],
      record(request.query)["projectId"],
      record(request.body)["projectId"],
      request.headers["x-qa-project-id"],
    ].filter((value) => value !== undefined);
    if (
      candidates.some((value) => typeof value !== "string" || !value) ||
      new Set(candidates).size > 1
    ) {
      throw Object.assign(new Error("request project identifiers disagree"), {
        code: "PROJECT_MISMATCH",
      });
    }
    const explicit = candidates[0] as string | undefined;
    const identifiers = [
      ["bugId", "bug"],
      ["attachmentId", "attachment"],
      ["captureId", "capture"],
      ["buildId", "build"],
      ["verificationId", "verification"],
      ["repairAttemptId", "repair"],
      ["attemptId", "repair"],
      ["sessionId", "upload"],
    ] as const;
    let actual: string | undefined;
    for (const [parameter, recordType] of identifiers) {
      const recordId = params[parameter];
      if (typeof recordId !== "string") continue;
      const result = await service.execute<{ projectId: string }>(principal, {
        operation: "recordProject",
        recordType,
        recordId,
        ...(explicit ? { projectId: explicit } : {}),
      });
      if (actual && actual !== result.projectId)
        throw Object.assign(new Error("records do not share a project"), {
          code: "PROJECT_MISMATCH",
        });
      actual = result.projectId;
    }
    const selected = explicit ?? actual ?? principal.projectId;
    if (!selected) throw Object.assign(new Error("请选择项目"), { code: "PROJECT_REQUIRED" });
    return selected;
  }
}
