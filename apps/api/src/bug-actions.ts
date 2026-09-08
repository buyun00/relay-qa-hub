import type { FastifyInstance } from "fastify";
import { getBrowserPrincipal } from "./browser-auth.js";
import type { MobileBugStore } from "./mobile-bugs.js";
import {
  parseMobileBugReadyRequest,
  parseMobileBugCompleteRequest,
  parseMobileBugManualCompleteRequest,
  parseMobileRepairAttemptRequest,
  parseMobileRepairAttemptStartRequest,
  parseMobileRepairAttemptDeliveryRequest,
  type MobileRelayStore,
} from "./mobile-relay.js";
import {
  parseMobileCreateVerificationRequest,
  parseMobileStartVerificationRequest,
  parseMobileRecordVerificationResultRequest,
  type MobileVerificationStore,
} from "./mobile-verification.js";

export const BUG_ACTIONS = [
  "ready",
  "manual_complete",
  "complete",
  "plan_fix",
  "begin_fix",
  "submit_fix",
  "create_verification",
  "start_verification",
  "verify_pass",
  "verify_fail",
  "close",
  "reject",
] as const;
export type BugAction = (typeof BUG_ACTIONS)[number];
interface BugActionStores {
  readonly bugs: MobileBugStore;
  readonly relay: MobileRelayStore;
  readonly verification: MobileVerificationStore;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("request must be an object");
  return value as Record<string, unknown>;
}
function requiredText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("text field is required");
  return value;
}

/** These adapters call the same stateful store operations as the legacy HTTP routes. */
export class BugActionService {
  constructor(private readonly stores: BugActionStores) {}

  async execute(
    actorId: string,
    projectId: string,
    bugId: string,
    idempotencyKey: string,
    value: unknown,
  ): Promise<unknown> {
    const body = object(value);
    const action = body["action"];
    if (typeof action !== "string" || !(BUG_ACTIONS as readonly string[]).includes(action))
      throw new TypeError("unsupported Bug action");
    const request = body["request"] === undefined ? {} : object(body["request"]);
    const expectedVersion = body["expectedVersion"];
    if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 1)
      throw new TypeError("expectedVersion is required");
    if (request["expectedVersion"] !== undefined && request["expectedVersion"] !== expectedVersion)
      throw new TypeError("expectedVersion fields disagree");
    const payload = { ...request, expectedVersion };
    const base = { actorId, bugId, idempotencyKey };
    let result: unknown;
    if (action === "ready")
      result = await this.stores.relay.transitionBugReady({
        ...base,
        request: parseMobileBugReadyRequest({ ...payload, toState: "ready" }),
      });
    else if (action === "manual_complete")
      result = await this.stores.relay.manuallyCompleteBug({
        ...base,
        request: parseMobileBugManualCompleteRequest({
          ...payload,
          reason: body["note"] ?? request["reason"],
        }),
      });
    else if (action === "complete")
      result = await this.stores.relay.completeBugForVerification({
        ...base,
        request: parseMobileBugCompleteRequest({
          ...payload,
          reason: body["note"] ?? request["reason"],
        }),
      });
    else if (action === "plan_fix") {
      const plan = parseMobileRepairAttemptRequest({
        ...payload,
        mode: "human",
        assigneeId: request["assigneeId"] ?? actorId,
      });
      if (plan.mode !== "human") throw new TypeError("manual repair required");
      result = await this.stores.relay.createManualAttempt({ ...base, request: plan });
    } else if (action === "begin_fix" || action === "submit_fix") {
      const attemptId = requiredText(body["attemptId"]);
      const attempt = await this.stores.relay.getManualAttempt({ actorId, attemptId });
      if (!attempt || attempt.bugId !== bugId)
        throw Object.assign(new Error("repair attempt not found for Bug"), { code: "NOT_FOUND" });
      result =
        action === "begin_fix"
          ? await this.stores.relay.startManualAttempt({
              actorId,
              attemptId,
              idempotencyKey,
              request: parseMobileRepairAttemptStartRequest(payload),
            })
          : await this.stores.relay.deliverManualAttempt({
              actorId,
              attemptId,
              idempotencyKey,
              request: parseMobileRepairAttemptDeliveryRequest(payload),
            });
    } else if (action === "create_verification") {
      result = await this.stores.verification.createVerification({
        ...base,
        request: parseMobileCreateVerificationRequest(payload),
      });
    } else {
      const verificationId = requiredText(body["verificationId"]);
      const verification = await this.stores.verification.getVerification({
        actorId,
        verificationId,
      });
      if (!verification || verification.bugId !== bugId)
        throw Object.assign(new Error("verification not found for Bug"), { code: "NOT_FOUND" });
      result =
        action === "start_verification"
          ? await this.stores.verification.startVerification({
              actorId,
              verificationId,
              idempotencyKey,
              request: parseMobileStartVerificationRequest(payload),
            })
          : await this.stores.verification.recordResult({
              actorId,
              verificationId,
              idempotencyKey,
              request: parseMobileRecordVerificationResultRequest({
                ...payload,
                status: action === "verify_pass" || action === "close" ? "passed" : "failed",
              }),
            });
    }
    const bug = await this.stores.bugs.getBug({ actorId, bugId });
    if (!bug || bug.projectId !== projectId) throw new Error("BUG_ACTION_PROJECT_INVARIANT");
    return { action, projectId, bugId, result, bug };
  }
}

export function registerBugActionRoutes(app: FastifyInstance, stores: BugActionStores): void {
  const service = new BugActionService(stores);
  app.get("/api/v1/bug-actions", async () => ({
    items: BUG_ACTIONS,
    version: "project-components-2.1",
  }));
  app.post<{ Params: { projectId: string; bugId: string } }>(
    "/api/v1/projects/:projectId/bugs/:bugId/actions",
    async (request, reply) => {
      const actor = getBrowserPrincipal(request);
      if (!actor) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      try {
        const key = requiredText(request.headers["idempotency-key"]);
        if (key.length > 255) throw new TypeError("Idempotency-Key too long");
        return await service.execute(
          actor.actorId,
          request.params.projectId,
          request.params.bugId,
          key,
          request.body,
        );
      } catch (error) {
        const code =
          error instanceof TypeError
            ? "INVALID_REQUEST"
            : ((error as { code?: string }).code ?? "INTERNAL_ERROR");
        const status =
          code === "NOT_FOUND"
            ? 404
            : code === "FORBIDDEN"
              ? 403
              : ["VERSION_CONFLICT", "IDEMPOTENCY_PAYLOAD_MISMATCH"].includes(code)
                ? 409
                : code === "GUARD_FAILED"
                  ? 422
                  : code === "INVALID_REQUEST"
                    ? 400
                    : 500;
        return reply.code(status).send({ code });
      }
    },
  );
}
