import type { FastifyInstance } from "fastify";
import type { MobileBugRecord, RepairAttemptDetail } from "@relay-qa-hub/storage";
import { getBrowserPrincipal } from "./browser-auth.js";
import { MOBILE_API_MEDIA_TYPE } from "./mobile-bugs.js";

type Representation = "legacy-1.0" | "vendor-1.1";
type Operation = "failRepairAttempt" | "supersedeRepairAttempt";
export interface TerminalAttemptRequest {
  readonly expectedVersion: number;
  readonly reason: string;
  readonly successor?: {
    readonly id: string;
    readonly mode: "human" | "relay" | "external";
    readonly assigneeId: string;
    readonly summary?: string;
  };
}
export interface TerminalAttemptCommand extends TerminalAttemptRequest {
  readonly accountId: string;
  readonly projectId: string;
  readonly actorId: string;
  /** Authenticated server principal fact; never read from the command body. */
  readonly isGm: boolean;
  readonly attemptId: string;
  readonly operation: Operation;
  readonly representation: Representation;
  readonly responseMedia: TerminalResponseMedia;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}
export interface TerminalAttemptResult {
  readonly representation: Representation;
  readonly responseMedia: TerminalResponseMedia;
  readonly reason: string;
  readonly attempt: RepairAttemptDetail;
  readonly successor: RepairAttemptDetail | null;
  readonly bug: MobileBugRecord;
  readonly eventId: string;
  readonly replayed: boolean;
}
export interface TerminalAttemptStore {
  readonly execute: (
    command: TerminalAttemptCommand,
  ) => TerminalAttemptResult | Promise<TerminalAttemptResult>;
  /** Optional legacy two-step branch attached to the existing create route. */
  readonly createAfterLegacy?: (
    command: CreateAfterLegacyCommand,
  ) => CreateAfterLegacyResult | Promise<CreateAfterLegacyResult>;
}
export type TerminalResponseMedia = "application/json" | typeof MOBILE_API_MEDIA_TYPE;
export interface CreateAfterLegacyRequest {
  readonly parentAttemptId: string;
  readonly expectedVersion: number;
  readonly mode: "human" | "relay" | "external";
  readonly assigneeId: string;
  readonly summary?: string;
}
export interface CreateAfterLegacyCommand extends CreateAfterLegacyRequest {
  readonly accountId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly isGm: boolean;
  readonly bugId: string;
  readonly responseMedia: TerminalResponseMedia;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}
export interface CreateAfterLegacyResult {
  readonly attempt: RepairAttemptDetail;
  readonly responseMedia: TerminalResponseMedia;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function reject(code: string): never {
  throw Object.assign(new Error(code), { code });
}
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject("INVALID_REQUEST");
  if (Object.keys(value).some((key) => !allowed.includes(key))) reject("INVALID_REQUEST");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || [...value].length > maximum)
    reject("INVALID_REQUEST");
  return value;
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) reject("INVALID_REQUEST");
  return value;
}
export function parseTerminalAttemptRequest(
  value: unknown,
  operation: Operation,
  representation: Representation,
): TerminalAttemptRequest {
  const successorRequired =
    operation === "supersedeRepairAttempt" && representation === "vendor-1.1";
  const body = object(
    value,
    successorRequired ? ["expectedVersion", "reason", "successor"] : ["expectedVersion", "reason"],
  );
  if (!Number.isSafeInteger(body["expectedVersion"]) || Number(body["expectedVersion"]) < 1)
    reject("INVALID_REQUEST");
  const base = {
    expectedVersion: Number(body["expectedVersion"]),
    reason: text(body["reason"], 5000),
  };
  if (!successorRequired) return base;
  const successor = object(body["successor"], ["id", "mode", "assigneeId", "summary"]);
  if (!["human", "relay", "external"].includes(String(successor["mode"])))
    reject("INVALID_REQUEST");
  return {
    ...base,
    successor: {
      id: identity(successor["id"]),
      mode: successor["mode"] as "human" | "relay" | "external",
      assigneeId: identity(successor["assigneeId"]),
      ...(successor["summary"] === undefined ? {} : { summary: text(successor["summary"], 10000) }),
    },
  };
}
export function parseCreateAfterLegacyRequest(value: unknown): CreateAfterLegacyRequest {
  const body = object(value, [
    "parentAttemptId",
    "expectedVersion",
    "mode",
    "assigneeId",
    "summary",
  ]);
  if (
    !Number.isSafeInteger(body["expectedVersion"]) ||
    Number(body["expectedVersion"]) < 1 ||
    !["human", "relay", "external"].includes(String(body["mode"]))
  )
    reject("INVALID_REQUEST");
  if (
    body["summary"] !== undefined &&
    (typeof body["summary"] !== "string" || [...body["summary"]].length > 5000)
  )
    reject("INVALID_REQUEST");
  return {
    parentAttemptId: identity(body["parentAttemptId"]),
    expectedVersion: Number(body["expectedVersion"]),
    mode: body["mode"] as "human" | "relay" | "external",
    assigneeId: identity(body["assigneeId"]),
    ...(body["summary"] === undefined ? {} : { summary: body["summary"] as string }),
  };
}
function errorResponse(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  const statuses: Record<string, number> = {
    INVALID_REQUEST: 400,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    NOT_ACCEPTABLE: 406,
    IDEMPOTENCY_PAYLOAD_MISMATCH: 409,
    INVALID_TRANSITION: 409,
    VERSION_CONFLICT: 412,
    UNSUPPORTED_MEDIA_TYPE: 415,
    GUARD_FAILED: 422,
  };
  return typeof code === "string" && statuses[code]
    ? { status: statuses[code]!, code }
    : { status: 500, code: "INTERNAL_ERROR" };
}
export function negotiateTerminalResponseMedia(
  accept: string | undefined,
  representation: Representation,
  operation: Operation,
): TerminalResponseMedia {
  const available: readonly TerminalResponseMedia[] =
    representation === "legacy-1.0" && operation === "supersedeRepairAttempt"
      ? ["application/json"]
      : representation === "legacy-1.0"
        ? ["application/json", MOBILE_API_MEDIA_TYPE]
        : [MOBILE_API_MEDIA_TYPE, "application/json"];
  if (accept === undefined || !accept.trim()) return available[0]!;
  const preferences = accept.split(",").map((part, index) => {
    const [media, ...parameters] = part.trim().toLowerCase().split(";");
    const quality = parameters.map((v) => v.trim()).find((v) => v.startsWith("q="));
    const q =
      quality === undefined
        ? 1
        : /^q=(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/u.test(quality)
          ? Number(quality.slice(2))
          : 0;
    return { media, q, index };
  });
  const ranked = available
    .flatMap((media, fallback) => {
      const matches = preferences
        .map((p) => ({
          ...p,
          specificity:
            p.media === media ? 2 : p.media === "application/*" ? 1 : p.media === "*/*" ? 0 : -1,
        }))
        .filter((p) => p.specificity >= 0)
        .sort((a, b) => b.specificity - a.specificity || b.q - a.q || a.index - b.index);
      const best = matches[0];
      return best && best.q > 0 ? [{ media, q: best.q, index: best.index, fallback }] : [];
    })
    .sort((a, b) => b.q - a.q || a.index - b.index || a.fallback - b.fallback);
  if (!ranked[0]) reject("NOT_ACCEPTABLE");
  return ranked[0].media;
}
function frozenAttempt(value: RepairAttemptDetail, summary = value.summary) {
  return {
    id: value.id,
    bugId: value.bugId,
    sequence: value.sequence,
    mode: value.mode,
    status: value.status,
    assigneeId: value.assigneeId,
    parentAttemptId: value.parentAttemptId,
    summary,
    branch: value.branch,
    commitSha: value.commitSha,
    mergeRequestUrl: value.mergeRequestUrl,
    targetBuildId: value.targetBuildId,
    version: value.version,
  };
}
export function projectTerminalAttemptResult(value: TerminalAttemptResult, media: string) {
  const attempt = frozenAttempt(value.attempt, value.reason);
  if (media === "application/json" || !value.successor) return attempt;
  return {
    supersededAttempt: attempt,
    successorAttempt: frozenAttempt(value.successor),
    bug: value.bug,
    eventId: value.eventId,
    replayed: value.replayed,
  };
}

/** Standalone contract fixture; createApiApp integrates these parsers behind its shared hooks. */
export function registerTerminalRepairAttemptRoutes(
  app: FastifyInstance,
  store: TerminalAttemptStore,
): void {
  for (const [suffix, operation] of [
    ["fail", "failRepairAttempt"],
    ["supersede", "supersedeRepairAttempt"],
  ] as const) {
    app.post<{ Params: { attemptId: string } }>(
      `/api/v1/repair-attempts/:attemptId/${suffix}`,
      async (request, reply) => {
        const principal = getBrowserPrincipal(request);
        if (!principal) return reply.code(401).send({ code: "UNAUTHENTICATED" });
        try {
          const contentType = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
          if (contentType !== "application/json" && contentType !== MOBILE_API_MEDIA_TYPE)
            reject("UNSUPPORTED_MEDIA_TYPE");
          const representation = contentType === "application/json" ? "legacy-1.0" : "vendor-1.1";
          const body = parseTerminalAttemptRequest(request.body, operation, representation);
          const attemptId = identity(request.params.attemptId);
          const suppliedProject = request.headers["x-qa-project-id"];
          const projectId = identity(suppliedProject ?? principal.projectId);
          const idempotencyKey = request.headers["idempotency-key"];
          if (
            typeof idempotencyKey !== "string" ||
            !idempotencyKey.trim() ||
            idempotencyKey.length > 200
          )
            reject("INVALID_REQUEST");
          if (
            representation === "vendor-1.1" &&
            idempotencyKey !== `workflow:${operation}:attempt:${attemptId}:v${body.expectedVersion}`
          )
            reject("INVALID_REQUEST");
          const media = negotiateTerminalResponseMedia(
            request.headers.accept,
            representation,
            operation,
          );
          const result = await store.execute({
            ...body,
            operation,
            representation,
            responseMedia: media,
            attemptId,
            projectId,
            accountId: principal.accountId,
            actorId: principal.actorId,
            isGm: principal.isGm === true,
            idempotencyKey,
            createdAt: new Date().toISOString(),
          });
          return reply
            .header("cache-control", "no-store")
            .type(`${result.responseMedia}; charset=utf-8`)
            .send(projectTerminalAttemptResult(result, result.responseMedia));
        } catch (error) {
          const result = errorResponse(error);
          return reply.code(result.status).send({ code: result.code });
        }
      },
    );
  }
  if (store.createAfterLegacy)
    app.post<{ Params: { bugId: string } }>(
      "/api/v1/bugs/:bugId/repair-attempts",
      async (request, reply) => {
        const principal = getBrowserPrincipal(request);
        if (!principal) return reply.code(401).send({ code: "UNAUTHENTICATED" });
        try {
          const contentType = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
          if (contentType !== "application/json" && contentType !== MOBILE_API_MEDIA_TYPE)
            reject("UNSUPPORTED_MEDIA_TYPE");
          const body = parseCreateAfterLegacyRequest(request.body),
            bugId = identity(request.params.bugId);
          const projectId = identity(request.headers["x-qa-project-id"] ?? principal.projectId);
          const key = request.headers["idempotency-key"];
          if (typeof key !== "string" || !key.trim() || key.length > 200) reject("INVALID_REQUEST");
          if (
            contentType === MOBILE_API_MEDIA_TYPE &&
            key !== `workflow:createRepairAttempt:bug:${bugId}:v${body.expectedVersion}`
          )
            reject("INVALID_REQUEST");
          const representation = contentType === "application/json" ? "legacy-1.0" : "vendor-1.1";
          const media = negotiateTerminalResponseMedia(
            request.headers.accept,
            representation,
            "failRepairAttempt",
          );
          const result = await store.createAfterLegacy!({
            ...body,
            bugId,
            projectId,
            accountId: principal.accountId,
            actorId: principal.actorId,
            isGm: principal.isGm === true,
            responseMedia: media,
            idempotencyKey: key,
            createdAt: new Date().toISOString(),
          });
          return reply
            .code(201)
            .header("cache-control", "no-store")
            .type(`${result.responseMedia}; charset=utf-8`)
            .send(frozenAttempt(result.attempt));
        } catch (error) {
          const result = errorResponse(error);
          return reply.code(result.status).send({ code: result.code });
        }
      },
    );
}
