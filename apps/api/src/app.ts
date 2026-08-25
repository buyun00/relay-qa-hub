import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";

import { API_SERVICE_NAME, API_VERSION, DEVELOPMENT_BUILD_SHA, resolveBuildSha } from "./config.js";
import {
  MAX_MOBILE_CHUNK_SIZE_BYTES,
  MOBILE_ATTACHMENT_BIND_PATH,
  MOBILE_ATTACHMENT_ITEM_PATH,
  MOBILE_BUG_ATTACHMENTS_PATH,
  MOBILE_CAPTURE_ARTIFACT_PATH,
  MOBILE_UPLOAD_CHUNK_PATH,
  MOBILE_UPLOAD_FINALIZE_PATH,
  MOBILE_UPLOAD_INIT_PATH,
  type MobileAttachmentStore,
  parseMobileAttachmentBindingRequest,
  parseMobileAttachmentListLimit,
  parseMobileChunkNumber,
  parseMobileFinalizeUploadRequest,
  parseMobileInitUploadRequest,
  parseStrongUploadVersion,
  requireMobileCaptureArtifactKind,
  requireMobileChunkSha256,
  requireMobileContentLength,
  requireMobileIdempotencyKey,
  requireMobileUuid,
} from "./mobile-attachments.js";
import {
  DEFAULT_DEBUG_ACTOR_ID,
  DEFAULT_DEBUG_BEARER_TOKEN,
  MOBILE_API_CONTENT_TYPE,
  MOBILE_API_MEDIA_TYPE,
  MOBILE_BUG_COLLECTION_PATH,
  MOBILE_BUG_ITEM_PATH,
  type MobileBugStore,
  parseMobileCreateBugRequest,
  parseMobileBugListQuery,
  parseMobileUpdateBugRequest,
} from "./mobile-bugs.js";
import {
  MOBILE_CAPTURE_COLLECTION_PATH,
  MOBILE_CAPTURE_ITEM_PATH,
  MobileCaptureRequestError,
  parseMobileCreateCaptureRequest,
  type MobileCaptureStore,
} from "./mobile-captures.js";
import {
  MOBILE_BUILD_COLLECTION_PATH,
  MOBILE_BUILD_ITEM_PATH,
  MOBILE_BUILD_LINK_REPAIR_PATH,
  parseMobileLinkBuildRepairRequest,
  parseMobileRegisterBuildRequest,
  requireBuildIdempotencyKey,
  requireBuildUuid,
  type MobileBuildStore,
} from "./mobile-builds.js";
import {
  MOBILE_BUG_DUPLICATE_CANDIDATES_PATH,
  MOBILE_BUG_MARK_DUPLICATE_PATH,
  parseMobileMarkDuplicateRequest,
  requireDuplicateBugUuid,
  type MobileDuplicateStore,
} from "./mobile-duplicates.js";
import {
  MOBILE_VERIFICATION_COLLECTION_PATH,
  MOBILE_VERIFICATION_ITEM_PATH,
  MOBILE_VERIFICATION_RESULT_PATH,
  MOBILE_VERIFICATION_START_PATH,
  parseMobileCreateVerificationRequest,
  parseMobileRecordVerificationResultRequest,
  parseMobileStartVerificationRequest,
  requireVerificationIdempotencyKey,
  requireVerificationUuid,
  type MobileVerificationStore,
} from "./mobile-verification.js";
import {
  MOBILE_BUG_HUMAN_WORKFLOW_PATH,
  MOBILE_HUMAN_WORKFLOW_LATEST_PATH,
  type MobileHumanWorkflowStore,
} from "./mobile-human-workflows.js";
import {
  MOBILE_BUG_COMMENTS_PATH,
  MOBILE_BUG_EVENTS_PATH,
  parseMobileAddBugCommentRequest,
  parseMobileBugEventsLimit,
  requireMobileCommentIdempotencyKey,
  type MobileCommentStore,
} from "./mobile-comments.js";
import {
  MOBILE_NOTIFICATION_LIST_PATH,
  parseMobileNotificationLimit,
  type MobileNotificationStore,
} from "./mobile-inbox.js";
import {
  MOBILE_PROJECT_COLLECTION_PATH,
  MOBILE_PROJECT_MEMBERS_PATH,
  MOBILE_PROJECT_MODULES_PATH,
  parseMobileProjectDirectoryListQuery,
  requireMobileProjectUuid,
  type MobileProjectDirectoryStore,
} from "./mobile-project-directory.js";
import { startMobileNotificationHintChannel } from "./mobile-notification-hints.js";
import {
  MOBILE_BUG_REPAIR_ATTEMPTS_PATH,
  MOBILE_BUG_TRANSITION_PATH,
  MOBILE_REPAIR_ATTEMPT_DELIVER_PATH,
  MOBILE_REPAIR_ATTEMPT_ITEM_PATH,
  MOBILE_REPAIR_ATTEMPT_START_PATH,
  MOBILE_RELAY_DISPATCH_PATH,
  MOBILE_RELAY_RECEIPT_PATH,
  parseMobileBugReadyRequest,
  parseMobileRepairAttemptDeliveryRequest,
  parseMobileRepairAttemptRequest,
  parseMobileRepairAttemptStartRequest,
  parseMobileRelayDispatchRequest,
  requireRelayIdempotencyKey,
  requireRelayUuid,
  type MobileRelayStore,
} from "./mobile-relay.js";
import {
  MAX_RELAY_WEBHOOK_BYTES,
  MOBILE_RELAY_WEBHOOK_PATH,
  MobileRelayWebhookRequestError,
  authenticateMobileRelayWebhook,
  parseMobileRelayDeliveredWebhook,
  relayWebhookPayloadDigest,
  validateMobileRelayWebhookHeaders,
  type MobileRelayWebhookStore,
} from "./mobile-relay-webhook.js";

export const LIVE_HEALTH_PATH = "/api/v1/health/live" as const;

export interface LiveHealth {
  readonly status: "ok";
  readonly service: typeof API_SERVICE_NAME;
  readonly version: string;
  readonly buildSha: string;
  readonly time: string;
}

export interface CreateApiAppOptions {
  readonly version?: string;
  readonly buildSha?: string;
  readonly now?: () => Date;
  readonly logger?: boolean;
  readonly mobileBugStore?: MobileBugStore;
  readonly mobileAttachmentStore?: MobileAttachmentStore;
  readonly mobileCaptureStore?: MobileCaptureStore;
  readonly mobileRelayStore?: MobileRelayStore;
  readonly mobileBuildStore?: MobileBuildStore;
  readonly mobileDuplicateStore?: MobileDuplicateStore;
  readonly mobileVerificationStore?: MobileVerificationStore;
  readonly mobileHumanWorkflowStore?: MobileHumanWorkflowStore;
  readonly mobileCommentStore?: MobileCommentStore;
  readonly mobileNotificationStore?: MobileNotificationStore;
  readonly mobileProjectDirectoryStore?: MobileProjectDirectoryStore;
  readonly mobileRelayWebhookStore?: MobileRelayWebhookStore;
  readonly relayWebhookSecret?: string;
  readonly debugBearerToken?: string;
  readonly debugActorId?: string;
}

const liveHealthResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "service", "version", "buildSha", "time"],
  properties: {
    status: { const: "ok" },
    service: { const: API_SERVICE_NAME },
    version: { type: "string", minLength: 1, maxLength: 100 },
    buildSha: { type: "string", pattern: "^(dev|[0-9a-f]{40})$" },
    time: { type: "string", format: "date-time" },
  },
} as const;

const unconfiguredMobileBugStore: MobileBugStore = {
  createBug: () => {
    throw new Error("MobileBugStore is not configured");
  },
  listBugs: () => {
    throw new Error("MobileBugStore is not configured");
  },
  getBug: () => null,
  updateBug: () => {
    throw new Error("MobileBugStore is not configured");
  },
};

const unconfiguredMobileAttachmentStore: MobileAttachmentStore = {
  initUpload: () => {
    throw new Error("MobileAttachmentStore is not configured");
  },
  putChunk: () => {
    throw new Error("MobileAttachmentStore is not configured");
  },
  finalizeUpload: () => {
    throw new Error("MobileAttachmentStore is not configured");
  },
  bindAttachment: () => {
    throw new Error("MobileAttachmentStore is not configured");
  },
  listBugAttachments: () => {
    throw new Error("MobileAttachmentStore is not configured");
  },
  getAttachment: () => {
    throw new Error("MobileAttachmentStore is not configured");
  },
  getCaptureArtifact: () => {
    throw new Error("MobileAttachmentStore is not configured");
  },
};

const unconfiguredMobileCaptureStore: MobileCaptureStore = {
  createCapture: () => {
    throw new Error("MobileCaptureStore is not configured");
  },
  getCapture: () => null,
};

const unconfiguredMobileRelayStore: MobileRelayStore = {
  transitionBugReady: () => {
    throw new Error("MobileRelayStore is not configured");
  },
  createRelayAttempt: () => {
    throw new Error("MobileRelayStore is not configured");
  },
  createManualAttempt: () => {
    throw new Error("MobileRelayStore is not configured");
  },
  getManualAttempt: () => null,
  startManualAttempt: () => {
    throw new Error("MobileRelayStore is not configured");
  },
  deliverManualAttempt: () => {
    throw new Error("MobileRelayStore is not configured");
  },
  dispatchRelay: () => {
    throw new Error("MobileRelayStore is not configured");
  },
  getRelayReceipt: () => null,
};

const unconfiguredMobileBuildStore: MobileBuildStore = {
  registerBuild: () => {
    throw new Error("MobileBuildStore is not configured");
  },
  getBuild: () => null,
  linkRepair: () => {
    throw new Error("MobileBuildStore is not configured");
  },
};

const unconfiguredMobileDuplicateStore: MobileDuplicateStore = {
  listCandidates: () => {
    throw new Error("MobileDuplicateStore is not configured");
  },
  markDuplicate: () => {
    throw new Error("MobileDuplicateStore is not configured");
  },
};

const unconfiguredMobileVerificationStore: MobileVerificationStore = {
  createVerification: () => {
    throw new Error("MobileVerificationStore is not configured");
  },
  getVerification: () => null,
  startVerification: () => {
    throw new Error("MobileVerificationStore is not configured");
  },
  recordResult: () => {
    throw new Error("MobileVerificationStore is not configured");
  },
};

const unconfiguredMobileHumanWorkflowStore: MobileHumanWorkflowStore = {
  getLatest: () => null,
  getForBug: () => {
    throw new Error("MobileHumanWorkflowStore is not configured");
  },
};

const unconfiguredMobileCommentStore: MobileCommentStore = {
  addComment: () => {
    throw new Error("MobileCommentStore is not configured");
  },
  listEvents: () => {
    throw new Error("MobileCommentStore is not configured");
  },
};

const unconfiguredMobileNotificationStore: MobileNotificationStore = {
  listNotifications: () => {
    throw new Error("MobileNotificationStore is not configured");
  },
};

const unconfiguredMobileProjectDirectoryStore: MobileProjectDirectoryStore = {
  listProjects: () => {
    throw new Error("MobileProjectDirectoryStore is not configured");
  },
  listMembers: () => {
    throw new Error("MobileProjectDirectoryStore is not configured");
  },
  listModules: () => {
    throw new Error("MobileProjectDirectoryStore is not configured");
  },
};

const unconfiguredMobileRelayWebhookStore: MobileRelayWebhookStore = {
  receiveRelayWebhook: () => {
    throw new Error("MobileRelayWebhookStore is not configured");
  },
};

function readHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function createLiveHealth(
  options: Pick<CreateApiAppOptions, "version" | "buildSha" | "now"> = {},
): LiveHealth {
  const version = options.version ?? API_VERSION;
  if (version.length === 0 || version.length > 100) {
    throw new Error("API version must contain from 1 through 100 characters");
  }

  return {
    status: "ok",
    service: API_SERVICE_NAME,
    version,
    buildSha: resolveBuildSha(options.buildSha ?? DEVELOPMENT_BUILD_SHA),
    time: (options.now ?? (() => new Date()))().toISOString(),
  };
}

export function createApiApp(options: CreateApiAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });
  const mobileBugStore = options.mobileBugStore ?? unconfiguredMobileBugStore;
  const mobileAttachmentStore = options.mobileAttachmentStore ?? unconfiguredMobileAttachmentStore;
  const mobileCaptureStore = options.mobileCaptureStore ?? unconfiguredMobileCaptureStore;
  const mobileRelayStore = options.mobileRelayStore ?? unconfiguredMobileRelayStore;
  const mobileBuildStore = options.mobileBuildStore ?? unconfiguredMobileBuildStore;
  const mobileDuplicateStore = options.mobileDuplicateStore ?? unconfiguredMobileDuplicateStore;
  const mobileVerificationStore =
    options.mobileVerificationStore ?? unconfiguredMobileVerificationStore;
  const mobileHumanWorkflowStore =
    options.mobileHumanWorkflowStore ?? unconfiguredMobileHumanWorkflowStore;
  const mobileCommentStore = options.mobileCommentStore ?? unconfiguredMobileCommentStore;
  const mobileNotificationStore =
    options.mobileNotificationStore ?? unconfiguredMobileNotificationStore;
  const mobileProjectDirectoryStore =
    options.mobileProjectDirectoryStore ?? unconfiguredMobileProjectDirectoryStore;
  const mobileRelayWebhookStore =
    options.mobileRelayWebhookStore ?? unconfiguredMobileRelayWebhookStore;
  const relayWebhookSecret = options.relayWebhookSecret ?? "";
  const debugBearerToken = options.debugBearerToken ?? DEFAULT_DEBUG_BEARER_TOKEN;
  const debugActorId = options.debugActorId ?? DEFAULT_DEBUG_ACTOR_ID;

  if (debugBearerToken.length === 0) throw new Error("debugBearerToken must not be empty");

  if (options.mobileNotificationStore !== undefined) {
    const notificationHintChannel = startMobileNotificationHintChannel({
      server: app.server,
      store: mobileNotificationStore,
      actorId: debugActorId,
      bearerToken: debugBearerToken,
      ...(options.now === undefined ? {} : { now: options.now }),
      logger: app.log,
    });
    // Upgrade sockets are not ordinary Fastify requests; close them before the
    // underlying HTTP server waits for its connections during app.close().
    app.addHook("preClose", async () => notificationHintChannel.close());
  }

  app.addContentTypeParser(MOBILE_API_MEDIA_TYPE, { parseAs: "string" }, (_request, body, done) => {
    try {
      done(null, JSON.parse(typeof body === "string" ? body : body.toString("utf8")));
    } catch (error: unknown) {
      done(error instanceof Error ? error : new Error("invalid JSON"), undefined);
    }
  });
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: MAX_MOBILE_CHUNK_SIZE_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.get(
    LIVE_HEALTH_PATH,
    {
      schema: {
        response: {
          200: liveHealthResponseSchema,
        },
      },
    },
    async (): Promise<LiveHealth> => createLiveHealth(options),
  );

  app.get<{
    Querystring: {
      readonly cursor?: string | readonly string[];
      readonly limit?: string | readonly string[];
    };
  }>(MOBILE_PROJECT_COLLECTION_PATH, async (request, reply) => {
    if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
      return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
    }
    try {
      const query = parseMobileProjectDirectoryListQuery(request.query);
      const result = await mobileProjectDirectoryStore.listProjects({
        actorId: debugActorId,
        limit: query.limit,
      });
      return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
    } catch (error: unknown) {
      const code = (error as { code?: unknown })?.code;
      if (code === "FORBIDDEN") {
        return reply.code(403).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
      }
      if (error instanceof TypeError || code === "INVALID_REQUEST") {
        return reply
          .code(400)
          .header("content-type", MOBILE_API_CONTENT_TYPE)
          .send({ code: "INVALID_REQUEST" });
      }
      throw error;
    }
  });

  app.get<{
    Params: { projectId: string };
    Querystring: {
      readonly cursor?: string | readonly string[];
      readonly limit?: string | readonly string[];
    };
  }>(MOBILE_PROJECT_MEMBERS_PATH, async (request, reply) => {
    if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
      return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
    }
    try {
      const projectId = requireMobileProjectUuid(request.params.projectId, "projectId");
      const query = parseMobileProjectDirectoryListQuery(request.query);
      const result = await mobileProjectDirectoryStore.listMembers({
        actorId: debugActorId,
        projectId,
        limit: query.limit,
      });
      return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
    } catch (error: unknown) {
      const code = (error as { code?: unknown })?.code;
      if (code === "NOT_FOUND") {
        return reply.code(404).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
      }
      if (code === "FORBIDDEN") {
        return reply.code(403).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
      }
      if (error instanceof TypeError || code === "INVALID_REQUEST") {
        return reply
          .code(400)
          .header("content-type", MOBILE_API_CONTENT_TYPE)
          .send({ code: "INVALID_REQUEST" });
      }
      throw error;
    }
  });

  app.get<{ Params: { projectId: string } }>(
    MOBILE_PROJECT_MODULES_PATH,
    async (request, reply) => {
      if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
        return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
      }
      try {
        const projectId = requireMobileProjectUuid(request.params.projectId, "projectId");
        const result = await mobileProjectDirectoryStore.listModules({
          actorId: debugActorId,
          projectId,
        });
        return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
      } catch (error: unknown) {
        const code = (error as { code?: unknown })?.code;
        if (code === "NOT_FOUND") {
          return reply.code(404).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
        }
        if (code === "FORBIDDEN") {
          return reply.code(403).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
        }
        if (error instanceof TypeError || code === "INVALID_REQUEST") {
          return reply
            .code(400)
            .header("content-type", MOBILE_API_CONTENT_TYPE)
            .send({ code: "INVALID_REQUEST" });
        }
        throw error;
      }
    },
  );

  app.post(
    MOBILE_RELAY_WEBHOOK_PATH,
    {
      bodyLimit: MAX_RELAY_WEBHOOK_BYTES,
      preParsing: async (request, _reply, payload) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        for await (const chunk of payload) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += bytes.length;
          if (totalBytes > MAX_RELAY_WEBHOOK_BYTES) {
            throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
          }
          chunks.push(bytes);
        }
        const rawBody = Buffer.concat(chunks, totalBytes);
        (request as typeof request & { relayWebhookRawBody?: Buffer }).relayWebhookRawBody =
          rawBody;
        return Readable.from([rawBody]);
      },
    },
    async (request, reply) => {
      const rawBody = (request as typeof request & { relayWebhookRawBody?: Buffer })
        .relayWebhookRawBody;
      try {
        if (rawBody === undefined) {
          throw new MobileRelayWebhookRequestError("INVALID_REQUEST");
        }
        authenticateMobileRelayWebhook({
          rawBody,
          secret: relayWebhookSecret,
          signature: readHeader(request.headers["x-relay-signature"]),
          timestamp: readHeader(request.headers["x-relay-timestamp"]),
          now: (options.now ?? (() => new Date()))(),
        });
        const webhook = parseMobileRelayDeliveredWebhook(request.body);
        validateMobileRelayWebhookHeaders({
          webhook,
          idempotencyKey: readHeader(request.headers["idempotency-key"]),
          deliveryId: readHeader(request.headers["x-relay-delivery-id"]),
          eventId: readHeader(request.headers["x-relay-event-id"]),
        });
        const result = await mobileRelayWebhookStore.receiveRelayWebhook({
          relayInstanceId: webhook.relayInstanceId,
          eventId: webhook.eventId,
          deliveryId: webhook.deliveryId,
          eventType: webhook.eventType,
          handoffId: webhook.handoffId,
          attemptId: webhook.attemptId,
          externalRevision: webhook.externalRevision,
          occurredAt: webhook.occurredAt,
          taskId: webhook.payload.taskId,
          turnId: webhook.payload.turnId,
          commitSha: webhook.payload.deliveryEvidence.commitSha,
          remoteSha: webhook.payload.deliveryEvidence.remoteSha,
          branch: webhook.payload.deliveryEvidence.branch,
          mergeRequestUrl: webhook.payload.deliveryEvidence.mergeRequestUrl,
          payloadDigest: relayWebhookPayloadDigest(rawBody),
          rawPayloadJson: rawBody.toString("utf8"),
          receivedAt: (options.now ?? (() => new Date()))().toISOString(),
        });
        return reply.code(202).send({
          requestId: randomUUID(),
          outboxMessageId: result.inboxMessageId,
          status: "accepted",
          replayed: result.replayed,
        });
      } catch (error: unknown) {
        if (error instanceof MobileRelayWebhookRequestError) {
          const statusCode =
            error.code === "INTEGRATION_SIGNATURE_INVALID"
              ? 401
              : error.code === "RELAY_DELIVERY_EVIDENCE_INVALID"
                ? 422
                : 400;
          return reply.code(statusCode).send({ code: error.code });
        }
        const code = (error as { code?: unknown })?.code;
        if (code === "NOT_FOUND") return reply.code(404).send({ code });
        if (code === "INTEGRATION_EVENT_CONFLICT") {
          return reply.code(409).send({ code });
        }
        throw error;
      }
    },
  );

  app.post(MOBILE_BUG_COLLECTION_PATH, async (request, reply) => {
    if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
      return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
    }

    try {
      const body = parseMobileCreateBugRequest(request.body);
      const idempotencyKey = readHeader(request.headers["idempotency-key"]);
      if (idempotencyKey !== `submission:${body.clientSubmissionId}:commit`) {
        throw new TypeError("Idempotency-Key does not match clientSubmissionId");
      }
      const response = await mobileBugStore.createBug({
        actorId: debugActorId,
        idempotencyKey,
        request: body,
      });
      return reply.code(201).header("content-type", MOBILE_API_CONTENT_TYPE).send(response);
    } catch (error: unknown) {
      if (!(error instanceof TypeError)) throw error;
      return reply
        .code(400)
        .header("content-type", MOBILE_API_CONTENT_TYPE)
        .send({ code: "INVALID_REQUEST" });
    }
  });

  app.get<{
    Querystring: {
      readonly projectId?: string | readonly string[];
      readonly q?: string | readonly string[];
      readonly state?: string | readonly string[];
      readonly severity?: string | readonly string[];
      readonly limit?: string | readonly string[];
    };
  }>(MOBILE_BUG_COLLECTION_PATH, async (request, reply) => {
    if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
      return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
    }
    try {
      const query = parseMobileBugListQuery(request.query);
      const result = await mobileBugStore.listBugs({
        actorId: debugActorId,
        ...query,
      });
      return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
    } catch (error: unknown) {
      const code = (error as { code?: unknown })?.code;
      if (code === "FORBIDDEN") {
        return reply.code(403).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
      }
      if (error instanceof TypeError || code === "INVALID_REQUEST") {
        return reply
          .code(400)
          .header("content-type", MOBILE_API_CONTENT_TYPE)
          .send({ code: "INVALID_REQUEST" });
      }
      throw error;
    }
  });

  app.get<{ Params: { bugId: string } }>(MOBILE_BUG_ITEM_PATH, async (request, reply) => {
    if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
      return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
    }

    const bug = await mobileBugStore.getBug({
      actorId: debugActorId,
      bugId: request.params.bugId,
    });
    if (bug === null) {
      return reply.code(404).send({ code: "NOT_FOUND" });
    }
    return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(bug);
  });

  app.get<{
    Params: { bugId: string };
    Querystring: { readonly limit?: string | readonly string[] };
  }>(MOBILE_BUG_ATTACHMENTS_PATH, async (request, reply) => {
    if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
      return reply
        .code(401)
        .header("content-type", MOBILE_API_CONTENT_TYPE)
        .send({ code: "UNAUTHENTICATED" });
    }
    try {
      const result = await mobileAttachmentStore.listBugAttachments({
        actorId: debugActorId,
        bugId: requireMobileUuid(request.params.bugId, "bugId"),
        limit: parseMobileAttachmentListLimit(request.query.limit),
      });
      if (result === null) {
        return reply
          .code(404)
          .header("content-type", MOBILE_API_CONTENT_TYPE)
          .send({ code: "NOT_FOUND" });
      }
      return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
    } catch (error: unknown) {
      if (!(error instanceof TypeError)) throw error;
      return reply
        .code(400)
        .header("content-type", MOBILE_API_CONTENT_TYPE)
        .send({ code: "INVALID_REQUEST" });
    }
  });

  app.get<{ Params: { attachmentId: string } }>(
    MOBILE_ATTACHMENT_ITEM_PATH,
    async (request, reply) => {
      if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
        return reply
          .code(401)
          .header("content-type", MOBILE_API_CONTENT_TYPE)
          .send({ code: "UNAUTHENTICATED" });
      }
      try {
        const download = await mobileAttachmentStore.getAttachment({
          actorId: debugActorId,
          attachmentId: requireMobileUuid(request.params.attachmentId, "attachmentId"),
        });
        if (download === null) {
          return reply
            .code(404)
            .header("content-type", MOBILE_API_CONTENT_TYPE)
            .send({ code: "NOT_FOUND" });
        }
        return reply
          .header("cache-control", "private, no-store")
          .header("content-length", download.metadata.size)
          .header("content-type", download.metadata.mediaType)
          .header("etag", `"sha256-${download.metadata.sha256}"`)
          .header("x-content-sha256", download.metadata.sha256)
          .send(download.bytes);
      } catch (error: unknown) {
        if (!(error instanceof TypeError)) throw error;
        return reply
          .code(400)
          .header("content-type", MOBILE_API_CONTENT_TYPE)
          .send({ code: "INVALID_REQUEST" });
      }
    },
  );

  app.get<{
    Params: { bugId: string; captureId: string; artifactKind: string };
  }>(MOBILE_CAPTURE_ARTIFACT_PATH, async (request, reply) => {
    if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
      return reply
        .code(401)
        .header("content-type", MOBILE_API_CONTENT_TYPE)
        .send({ code: "UNAUTHENTICATED" });
    }
    try {
      const download = await mobileAttachmentStore.getCaptureArtifact({
        actorId: debugActorId,
        bugId: requireMobileUuid(request.params.bugId, "bugId"),
        captureId: requireMobileUuid(request.params.captureId, "captureId"),
        artifactKind: requireMobileCaptureArtifactKind(request.params.artifactKind),
      });
      if (download === null) {
        return reply
          .code(404)
          .header("content-type", MOBILE_API_CONTENT_TYPE)
          .send({ code: "NOT_FOUND" });
      }
      return reply
        .header("cache-control", "private, no-store")
        .header("content-length", download.metadata.size)
        .header("content-type", download.metadata.mediaType)
        .header("etag", `"sha256-${download.metadata.sha256}"`)
        .header("x-content-sha256", download.metadata.sha256)
        .send(download.bytes);
    } catch (error: unknown) {
      if (!(error instanceof TypeError)) throw error;
      return reply
        .code(400)
        .header("content-type", MOBILE_API_CONTENT_TYPE)
        .send({ code: "INVALID_REQUEST" });
    }
  });

  app.patch<{ Params: { bugId: string } }>(MOBILE_BUG_ITEM_PATH, async (request, reply) => {
    if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
      return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
    }
    try {
      const bugId = requireRelayUuid(request.params.bugId, "bugId");
      const body = parseMobileUpdateBugRequest(request.body);
      const idempotencyKey = requireRelayIdempotencyKey(
        readHeader(request.headers["idempotency-key"]),
      );
      const result = await mobileBugStore.updateBug({
        actorId: debugActorId,
        bugId,
        idempotencyKey,
        request: body,
      });
      return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
    } catch (error: unknown) {
      const code = (error as { code?: unknown })?.code;
      if (code === "NOT_FOUND") {
        return reply.code(404).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
      }
      if (code === "FORBIDDEN") {
        return reply.code(403).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
      }
      if (code === "VERSION_CONFLICT") {
        return reply.code(412).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
      }
      if (code === "IDEMPOTENCY_PAYLOAD_MISMATCH") {
        return reply.code(409).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
      }
      if (error instanceof TypeError || code === "INVALID_REQUEST") {
        return reply
          .code(400)
          .header("content-type", MOBILE_API_CONTENT_TYPE)
          .send({ code: "INVALID_REQUEST" });
      }
      throw error;
    }
  });

  app.get<{ Params: { bugId: string } }>(
    MOBILE_BUG_DUPLICATE_CANDIDATES_PATH,
    async (request, reply) => {
      if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
        return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
      }
      try {
        const bugId = requireDuplicateBugUuid(request.params.bugId, "bugId");
        const result = await mobileDuplicateStore.listCandidates({
          actorId: debugActorId,
          bugId,
        });
        return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
      } catch (error: unknown) {
        const code = (error as { code?: unknown })?.code;
        if (code === "NOT_FOUND") {
          return reply.code(404).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
        }
        if (code === "FORBIDDEN") {
          return reply.code(403).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
        }
        if (error instanceof TypeError || code === "INVALID_REQUEST") {
          return reply
            .code(400)
            .header("content-type", MOBILE_API_CONTENT_TYPE)
            .send({ code: "INVALID_REQUEST" });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { bugId: string } }>(
    MOBILE_BUG_MARK_DUPLICATE_PATH,
    async (request, reply) => {
      if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
        return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
      }
      try {
        const bugId = requireDuplicateBugUuid(request.params.bugId, "bugId");
        const body = parseMobileMarkDuplicateRequest(request.body);
        const idempotencyKey = requireRelayIdempotencyKey(
          readHeader(request.headers["idempotency-key"]),
        );
        if (
          idempotencyKey !==
          `workflow:markBugDuplicate:bug:${bugId}:v${body.expectedVersion}:canonical:${body.canonicalBugId}`
        ) {
          throw new TypeError("Idempotency-Key does not match mark duplicate action");
        }
        const result = await mobileDuplicateStore.markDuplicate({
          actorId: debugActorId,
          bugId,
          idempotencyKey,
          request: body,
        });
        return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
      } catch (error: unknown) {
        const code = (error as { code?: unknown })?.code;
        if (code === "NOT_FOUND") {
          return reply.code(404).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
        }
        if (code === "FORBIDDEN") {
          return reply.code(403).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
        }
        if (code === "VERSION_CONFLICT") {
          return reply.code(412).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
        }
        if (code === "IDEMPOTENCY_PAYLOAD_MISMATCH") {
          return reply.code(409).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
        }
        if (code === "GUARD_FAILED") {
          return reply.code(422).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
        }
        if (error instanceof TypeError || code === "INVALID_REQUEST") {
          return reply
            .code(400)
            .header("content-type", MOBILE_API_CONTENT_TYPE)
            .send({ code: "INVALID_REQUEST" });
        }
        throw error;
      }
    },
  );

  const relayErrorReply = (error: unknown, reply: FastifyReply) => {
    const code = (error as { code?: unknown })?.code;
    if (code === "NOT_FOUND") {
      return reply.code(404).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
    }
    if (code === "VERSION_CONFLICT" || code === "IDEMPOTENCY_PAYLOAD_MISMATCH") {
      return reply.code(409).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
    }
    if (code === "GUARD_FAILED" || code === "RELAY_DELIVERY_EVIDENCE_INVALID") {
      return reply.code(422).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
    }
    if (error instanceof TypeError || code === "INVALID_REQUEST") {
      return reply
        .code(400)
        .header("content-type", MOBILE_API_CONTENT_TYPE)
        .send({
          code: code === "INVALID_REQUEST" ? code : "INVALID_REQUEST",
        });
    }
    throw error;
  };

  app.post<{ Params: { bugId: string } }>(MOBILE_BUG_TRANSITION_PATH, async (request, reply) => {
    if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
      return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
    }
    try {
      const bugId = requireRelayUuid(request.params.bugId, "bugId");
      const body = parseMobileBugReadyRequest(request.body);
      const idempotencyKey = requireRelayIdempotencyKey(
        readHeader(request.headers["idempotency-key"]),
      );
      if (idempotencyKey !== `workflow:transitionBug:bug:${bugId}:v${body.expectedVersion}:ready`) {
        throw new TypeError("Idempotency-Key does not match the ready transition");
      }
      const result = await mobileRelayStore.transitionBugReady({
        actorId: debugActorId,
        bugId,
        idempotencyKey,
        request: body,
      });
      return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
    } catch (error: unknown) {
      return relayErrorReply(error, reply);
    }
  });

  app.post<{ Params: { bugId: string } }>(
    MOBILE_BUG_REPAIR_ATTEMPTS_PATH,
    async (request, reply) => {
      if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
        return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
      }
      try {
        const bugId = requireRelayUuid(request.params.bugId, "bugId");
        const body = parseMobileRepairAttemptRequest(request.body);
        const idempotencyKey = requireRelayIdempotencyKey(
          readHeader(request.headers["idempotency-key"]),
        );
        if (
          idempotencyKey !== `workflow:createRepairAttempt:bug:${bugId}:v${body.expectedVersion}`
        ) {
          throw new TypeError("Idempotency-Key does not match RepairAttempt creation");
        }
        const result =
          body.mode === "human"
            ? await mobileRelayStore.createManualAttempt({
                actorId: debugActorId,
                bugId,
                idempotencyKey,
                request: body,
              })
            : await mobileRelayStore.createRelayAttempt({
                actorId: debugActorId,
                bugId,
                idempotencyKey,
                request: body,
              });
        return reply.code(201).header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
      } catch (error: unknown) {
        return relayErrorReply(error, reply);
      }
    },
  );

  app.post<{ Params: { attemptId: string } }>(
    MOBILE_REPAIR_ATTEMPT_START_PATH,
    async (request, reply) => {
      if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
        return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
      }
      try {
        const attemptId = requireRelayUuid(request.params.attemptId, "attemptId");
        const body = parseMobileRepairAttemptStartRequest(request.body);
        const idempotencyKey = requireRelayIdempotencyKey(
          readHeader(request.headers["idempotency-key"]),
        );
        if (
          idempotencyKey !==
          `workflow:startRepairAttempt:attempt:${attemptId}:v${body.expectedVersion}`
        ) {
          throw new TypeError("Idempotency-Key does not match RepairAttempt start");
        }
        const result = await mobileRelayStore.startManualAttempt({
          actorId: debugActorId,
          attemptId,
          idempotencyKey,
          request: body,
        });
        return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
      } catch (error: unknown) {
        return relayErrorReply(error, reply);
      }
    },
  );

  app.get<{ Params: { attemptId: string } }>(
    MOBILE_REPAIR_ATTEMPT_ITEM_PATH,
    async (request, reply) => {
      if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
        return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
      }
      try {
        const attemptId = requireRelayUuid(request.params.attemptId, "attemptId");
        const result = await mobileRelayStore.getManualAttempt({
          actorId: debugActorId,
          attemptId,
        });
        if (result === null) return reply.code(404).send({ code: "NOT_FOUND" });
        return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
      } catch (error: unknown) {
        return relayErrorReply(error, reply);
      }
    },
  );

  app.post<{ Params: { attemptId: string } }>(
    MOBILE_REPAIR_ATTEMPT_DELIVER_PATH,
    async (request, reply) => {
      if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
        return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
      }
      try {
        const attemptId = requireRelayUuid(request.params.attemptId, "attemptId");
        const body = parseMobileRepairAttemptDeliveryRequest(request.body);
        const idempotencyKey = requireRelayIdempotencyKey(
          readHeader(request.headers["idempotency-key"]),
        );
        if (
          idempotencyKey !==
          `workflow:deliverRepairAttempt:attempt:${attemptId}:v${body.expectedVersion}`
        ) {
          throw new TypeError("Idempotency-Key does not match RepairAttempt delivery");
        }
        if (body.deliveryKind !== "code") {
          return reply
            .code(422)
            .header("content-type", MOBILE_API_CONTENT_TYPE)
            .send({ code: "RELAY_DELIVERY_EVIDENCE_INVALID" });
        }
        const result = await mobileRelayStore.deliverManualAttempt({
          actorId: debugActorId,
          attemptId,
          idempotencyKey,
          request: body as typeof body & {
            readonly deliveryKind: "code";
            readonly branch: string;
            readonly commitSha: string;
          },
        });
        return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
      } catch (error: unknown) {
        return relayErrorReply(error, reply);
      }
    },
  );

  app.post<{ Params: { attemptId: string } }>(
    MOBILE_RELAY_DISPATCH_PATH,
    async (request, reply) => {
      if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
        return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
      }
      try {
        const attemptId = requireRelayUuid(request.params.attemptId, "attemptId");
        const body = parseMobileRelayDispatchRequest(request.body);
        const idempotencyKey = requireRelayIdempotencyKey(
          readHeader(request.headers["idempotency-key"]),
        );
        if (idempotencyKey !== `relay:dispatch:${body.handoffId}`) {
          throw new TypeError("Idempotency-Key does not match handoffId");
        }
        const result = await mobileRelayStore.dispatchRelay({
          actorId: debugActorId,
          attemptId,
          idempotencyKey,
          request: body,
        });
        return reply.code(202).header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
      } catch (error: unknown) {
        return relayErrorReply(error, reply);
      }
    },
  );

  app.get<{ Params: { attemptId: string } }>(MOBILE_RELAY_RECEIPT_PATH, async (request, reply) => {
    if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
      return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
    }
    try {
      const attemptId = requireRelayUuid(request.params.attemptId, "attemptId");
      const result = await mobileRelayStore.getRelayReceipt({
        actorId: debugActorId,
        attemptId,
      });
      if (result === null) return reply.code(404).send({ code: "NOT_FOUND" });
      return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
    } catch (error: unknown) {
      return relayErrorReply(error, reply);
    }
  });

  const buildErrorReply = (error: unknown, reply: FastifyReply) => {
    const code = (error as { code?: unknown })?.code;
    if (code === "NOT_FOUND") {
      return reply.code(404).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
    }
    if (code === "VERSION_CONFLICT") {
      return reply.code(412).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
    }
    if (
      code === "IDEMPOTENCY_PAYLOAD_MISMATCH" ||
      code === "INVALID_TRANSITION" ||
      code === "ACTIVE_REPAIR_EXISTS"
    ) {
      return reply.code(409).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
    }
    if (
      code === "BUILD_IDENTITY_MISMATCH" ||
      code === "RELAY_DELIVERY_EVIDENCE_INVALID" ||
      code === "GUARD_FAILED"
    ) {
      return reply.code(422).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
    }
    if (code === "FORBIDDEN" || code === "INTEGRATION_AUTOMATION_FORBIDDEN") {
      return reply.code(403).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
    }
    if (error instanceof TypeError || code === "INVALID_REQUEST") {
      return reply
        .code(400)
        .header("content-type", MOBILE_API_CONTENT_TYPE)
        .send({ code: "INVALID_REQUEST" });
    }
    throw error;
  };

  app.get<{ Params: { projectId: string } }>(
    MOBILE_HUMAN_WORKFLOW_LATEST_PATH,
    async (request, reply) => {
      if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
        return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
      }
      try {
        const projectId = requireBuildUuid(request.params.projectId, "projectId");
        const workflow = await mobileHumanWorkflowStore.getLatest({
          actorId: debugActorId,
          projectId,
        });
        if (workflow === null) {
          return reply
            .code(404)
            .header("content-type", MOBILE_API_CONTENT_TYPE)
            .send({ code: "NOT_FOUND" });
        }
        return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send({ workflow });
      } catch (error: unknown) {
        return buildErrorReply(error, reply);
      }
    },
  );

  app.get<{ Params: { bugId: string } }>(MOBILE_BUG_HUMAN_WORKFLOW_PATH, async (request, reply) => {
    if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
      return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
    }
    try {
      const bugId = requireRelayUuid(request.params.bugId, "bugId");
      const workflow = await mobileHumanWorkflowStore.getForBug({
        actorId: debugActorId,
        bugId,
      });
      return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(workflow);
    } catch (error: unknown) {
      return buildErrorReply(error, reply);
    }
  });

  app.post<{ Params: { bugId: string } }>(MOBILE_BUG_COMMENTS_PATH, async (request, reply) => {
    if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
      return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
    }
    try {
      const bugId = requireRelayUuid(request.params.bugId, "bugId");
      const body = parseMobileAddBugCommentRequest(request.body);
      const idempotencyKey = requireMobileCommentIdempotencyKey(
        readHeader(request.headers["idempotency-key"]),
        bugId,
        body.clientSubmissionId,
      );
      const result = await mobileCommentStore.addComment({
        actorId: debugActorId,
        bugId,
        idempotencyKey,
        request: body,
      });
      return reply
        .code(201)
        .header("content-type", MOBILE_API_CONTENT_TYPE)
        .send({
          comment: {
            id: result.comment.id,
            bugId: result.comment.bugId,
            authorId: result.comment.authorId,
            body: result.comment.body,
            clientSubmissionId: result.clientSubmissionId,
            createdAt: result.comment.createdAt,
            version: result.comment.version,
          },
        });
    } catch (error: unknown) {
      return relayErrorReply(error, reply);
    }
  });

  app.get<{
    Params: { bugId: string };
    Querystring: { limit?: string | string[] };
  }>(MOBILE_BUG_EVENTS_PATH, async (request, reply) => {
    if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
      return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
    }
    try {
      const bugId = requireRelayUuid(request.params.bugId, "bugId");
      const result = await mobileCommentStore.listEvents({
        actorId: debugActorId,
        bugId,
        limit: parseMobileBugEventsLimit(request.query.limit),
      });
      return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
    } catch (error: unknown) {
      return relayErrorReply(error, reply);
    }
  });

  app.post<{ Params: { projectId: string } }>(
    MOBILE_BUILD_COLLECTION_PATH,
    async (request, reply) => {
      if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
        return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
      }
      try {
        const projectId = requireBuildUuid(request.params.projectId, "projectId");
        const body = parseMobileRegisterBuildRequest(request.body);
        const idempotencyKey = requireBuildIdempotencyKey(
          readHeader(request.headers["idempotency-key"]),
        );
        if (
          idempotencyKey !==
          `build:register:project:${projectId}:provider:${body.provider}:external:${body.externalId}`
        ) {
          throw new TypeError("Idempotency-Key does not match Build registration");
        }
        const result = await mobileBuildStore.registerBuild({
          actorId: debugActorId,
          projectId,
          idempotencyKey,
          request: body,
        });
        return reply.code(201).header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
      } catch (error: unknown) {
        return buildErrorReply(error, reply);
      }
    },
  );

  app.get<{ Params: { buildId: string } }>(MOBILE_BUILD_ITEM_PATH, async (request, reply) => {
    if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
      return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
    }
    try {
      const buildId = requireBuildUuid(request.params.buildId, "buildId");
      const result = await mobileBuildStore.getBuild({ actorId: debugActorId, buildId });
      if (result === null) return reply.code(404).send({ code: "NOT_FOUND" });
      return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
    } catch (error: unknown) {
      return buildErrorReply(error, reply);
    }
  });

  app.post<{ Params: { buildId: string } }>(
    MOBILE_BUILD_LINK_REPAIR_PATH,
    async (request, reply) => {
      if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
        return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
      }
      try {
        const buildId = requireBuildUuid(request.params.buildId, "buildId");
        const body = parseMobileLinkBuildRepairRequest(request.body);
        const idempotencyKey = requireBuildIdempotencyKey(
          readHeader(request.headers["idempotency-key"]),
        );
        if (
          idempotencyKey !==
          `build:link:${buildId}:attempt:${body.repairAttemptId}:v${body.expectedVersion}`
        ) {
          throw new TypeError("Idempotency-Key does not match Build repair link");
        }
        const result = await mobileBuildStore.linkRepair({
          actorId: debugActorId,
          buildId,
          idempotencyKey,
          request: body,
        });
        return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
      } catch (error: unknown) {
        return buildErrorReply(error, reply);
      }
    },
  );

  app.post<{ Params: { bugId: string } }>(
    MOBILE_VERIFICATION_COLLECTION_PATH,
    async (request, reply) => {
      if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
        return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
      }
      try {
        const bugId = requireVerificationUuid(request.params.bugId, "bugId");
        const body = parseMobileCreateVerificationRequest(request.body);
        const idempotencyKey = requireVerificationIdempotencyKey(
          readHeader(request.headers["idempotency-key"]),
        );
        const expectedKey = `workflow:createVerification:bug:${bugId}:attempt:${body.repairAttemptId}:v${body.expectedVersion}`;
        if (idempotencyKey !== expectedKey) {
          throw new TypeError("Idempotency-Key does not match Verification creation");
        }
        const result = await mobileVerificationStore.createVerification({
          actorId: debugActorId,
          bugId,
          idempotencyKey,
          request: body,
        });
        return reply.code(201).header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
      } catch (error: unknown) {
        return buildErrorReply(error, reply);
      }
    },
  );

  app.get<{ Params: { verificationId: string } }>(
    MOBILE_VERIFICATION_ITEM_PATH,
    async (request, reply) => {
      if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
        return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
      }
      try {
        const verificationId = requireVerificationUuid(
          request.params.verificationId,
          "verificationId",
        );
        const result = await mobileVerificationStore.getVerification({
          actorId: debugActorId,
          verificationId,
        });
        if (result === null) return reply.code(404).send({ code: "NOT_FOUND" });
        return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
      } catch (error: unknown) {
        return buildErrorReply(error, reply);
      }
    },
  );

  app.post<{ Params: { verificationId: string } }>(
    MOBILE_VERIFICATION_START_PATH,
    async (request, reply) => {
      if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
        return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
      }
      try {
        const verificationId = requireVerificationUuid(
          request.params.verificationId,
          "verificationId",
        );
        const body = parseMobileStartVerificationRequest(request.body);
        const idempotencyKey = requireVerificationIdempotencyKey(
          readHeader(request.headers["idempotency-key"]),
        );
        const expectedKey = `workflow:startVerification:verification:${verificationId}:v${body.expectedVersion}`;
        if (idempotencyKey !== expectedKey) {
          throw new TypeError("Idempotency-Key does not match Verification start");
        }
        const result = await mobileVerificationStore.startVerification({
          actorId: debugActorId,
          verificationId,
          idempotencyKey,
          request: body,
        });
        return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
      } catch (error: unknown) {
        return buildErrorReply(error, reply);
      }
    },
  );

  app.post<{ Params: { verificationId: string } }>(
    MOBILE_VERIFICATION_RESULT_PATH,
    async (request, reply) => {
      if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
        return reply.code(401).send({ code: "NATIVE_SESSION_INVALID" });
      }
      try {
        const verificationId = requireVerificationUuid(
          request.params.verificationId,
          "verificationId",
        );
        const body = parseMobileRecordVerificationResultRequest(request.body);
        const idempotencyKey = requireVerificationIdempotencyKey(
          readHeader(request.headers["idempotency-key"]),
        );
        const expectedKey = `workflow:recordVerificationResult:verification:${verificationId}:v${body.expectedVersion}`;
        if (idempotencyKey !== expectedKey) {
          throw new TypeError("Idempotency-Key does not match Verification result");
        }
        const result = await mobileVerificationStore.recordResult({
          actorId: debugActorId,
          verificationId,
          idempotencyKey,
          request: body,
        });
        return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(result);
      } catch (error: unknown) {
        return buildErrorReply(error, reply);
      }
    },
  );

  app.get<{ Querystring: { limit?: string | string[] } }>(
    MOBILE_NOTIFICATION_LIST_PATH,
    async (request, reply) => {
      if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
        return reply
          .code(401)
          .header("content-type", MOBILE_API_CONTENT_TYPE)
          .send({ code: "UNAUTHENTICATED" });
      }
      try {
        const result = await mobileNotificationStore.listNotifications({
          actorId: debugActorId,
          limit: parseMobileNotificationLimit(request.query.limit),
          now: (options.now ?? (() => new Date()))().toISOString(),
        });
        return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send({
          items: result.items.map((item) => ({
            id: item.id,
            projectId: item.projectId,
            userId: item.userId,
            type: item.type,
            title: item.title,
            bugId: item.bugId,
            createdAt: item.createdAt,
            readAt: item.readAt,
            version: item.version,
          })),
          nextCursor: result.nextCursor,
          unreadCount: result.unreadCount,
        });
      } catch (error: unknown) {
        const code = (error as { code?: unknown })?.code;
        if (error instanceof TypeError || code === "INVALID_REQUEST") {
          return reply
            .code(400)
            .header("content-type", MOBILE_API_CONTENT_TYPE)
            .send({ code: "INVALID_REQUEST" });
        }
        throw error;
      }
    },
  );

  app.post(MOBILE_CAPTURE_COLLECTION_PATH, async (request, reply) => {
    if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
      return reply
        .code(401)
        .header("content-type", MOBILE_API_CONTENT_TYPE)
        .send({ code: "UNAUTHENTICATED" });
    }

    try {
      const body = parseMobileCreateCaptureRequest(request.body);
      const idempotencyKey = readHeader(request.headers["idempotency-key"]);
      if (
        idempotencyKey !== `submission:${body.clientSubmissionId}:capture:${body.capture.captureId}`
      ) {
        throw new MobileCaptureRequestError(
          "Idempotency-Key does not match the capture identity",
          "INVALID_REQUEST",
        );
      }
      const response = await mobileCaptureStore.createCapture({
        actorId: debugActorId,
        idempotencyKey,
        request: body,
      });
      return reply.code(201).header("content-type", MOBILE_API_CONTENT_TYPE).send(response);
    } catch (error: unknown) {
      if (error instanceof MobileCaptureRequestError) {
        return reply
          .code(400)
          .header("content-type", MOBILE_API_CONTENT_TYPE)
          .send({ code: error.code });
      }
      if (error instanceof TypeError) {
        return reply
          .code(400)
          .header("content-type", MOBILE_API_CONTENT_TYPE)
          .send({ code: "INVALID_REQUEST" });
      }
      throw error;
    }
  });

  app.get<{ Params: { captureId: string } }>(MOBILE_CAPTURE_ITEM_PATH, async (request, reply) => {
    if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
      return reply
        .code(401)
        .header("content-type", MOBILE_API_CONTENT_TYPE)
        .send({ code: "UNAUTHENTICATED" });
    }
    const capture = await mobileCaptureStore.getCapture({
      actorId: debugActorId,
      captureId: request.params.captureId,
    });
    if (capture === null) return reply.code(404).send({ code: "NOT_FOUND" });
    return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(capture);
  });

  app.post(MOBILE_UPLOAD_INIT_PATH, async (request, reply) => {
    if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
      return reply
        .code(401)
        .header("content-type", MOBILE_API_CONTENT_TYPE)
        .send({ code: "UNAUTHENTICATED" });
    }

    try {
      const body = parseMobileInitUploadRequest(request.body);
      const idempotencyKey = requireMobileIdempotencyKey(
        readHeader(request.headers["idempotency-key"]),
      );
      if (
        idempotencyKey !==
        `submission:${body.clientSubmissionId}:attachment:${body.clientAttachmentId}:upload:${body.uploadAttempt}:init`
      ) {
        throw new TypeError("Idempotency-Key does not match the upload identity");
      }
      const response = await mobileAttachmentStore.initUpload({
        actorId: debugActorId,
        idempotencyKey,
        request: body,
      });
      return reply.code(201).header("content-type", MOBILE_API_CONTENT_TYPE).send(response);
    } catch (error: unknown) {
      if (!(error instanceof TypeError)) throw error;
      return reply
        .code(400)
        .header("content-type", MOBILE_API_CONTENT_TYPE)
        .send({ code: "INVALID_REQUEST" });
    }
  });

  app.put<{ Params: { sessionId: string; chunkNumber: string } }>(
    MOBILE_UPLOAD_CHUNK_PATH,
    async (request, reply) => {
      if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
        return reply
          .code(401)
          .header("content-type", MOBILE_API_CONTENT_TYPE)
          .send({ code: "UNAUTHENTICATED" });
      }

      try {
        if (!Buffer.isBuffer(request.body)) {
          throw new TypeError("upload chunk body must be application/octet-stream");
        }
        const bytes = request.body;
        requireMobileContentLength(readHeader(request.headers["content-length"]), bytes);
        const chunkSha256 = requireMobileChunkSha256(
          readHeader(request.headers["x-chunk-sha256"]),
          bytes,
        );
        const result = await mobileAttachmentStore.putChunk({
          actorId: debugActorId,
          idempotencyKey: requireMobileIdempotencyKey(
            readHeader(request.headers["idempotency-key"]),
          ),
          sessionId: requireMobileUuid(request.params.sessionId, "sessionId"),
          chunkNumber: parseMobileChunkNumber(request.params.chunkNumber),
          expectedVersion: parseStrongUploadVersion(readHeader(request.headers["if-match"])),
          clientSubmissionId: requireMobileUuid(
            readHeader(request.headers["x-client-submission-id"]) ?? "",
            "X-Client-Submission-Id",
          ),
          clientAttachmentId: requireMobileUuid(
            readHeader(request.headers["x-client-attachment-id"]) ?? "",
            "X-Client-Attachment-Id",
          ),
          chunkSha256,
          bytes,
        });
        return reply
          .header("etag", `"${result.version}"`)
          .header("x-upload-version", result.version)
          .code(204)
          .send();
      } catch (error: unknown) {
        if (!(error instanceof TypeError)) throw error;
        return reply
          .code(400)
          .header("content-type", MOBILE_API_CONTENT_TYPE)
          .send({ code: "INVALID_REQUEST" });
      }
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    MOBILE_UPLOAD_FINALIZE_PATH,
    async (request, reply) => {
      if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
        return reply
          .code(401)
          .header("content-type", MOBILE_API_CONTENT_TYPE)
          .send({ code: "UNAUTHENTICATED" });
      }

      try {
        const body = parseMobileFinalizeUploadRequest(request.body);
        const idempotencyKey = requireMobileIdempotencyKey(
          readHeader(request.headers["idempotency-key"]),
        );
        if (
          idempotencyKey !==
          `submission:${body.clientSubmissionId}:attachment:${body.clientAttachmentId}:upload:${body.uploadAttempt}:finalize`
        ) {
          throw new TypeError("Idempotency-Key does not match the upload identity");
        }
        const response = await mobileAttachmentStore.finalizeUpload({
          actorId: debugActorId,
          idempotencyKey,
          sessionId: requireMobileUuid(request.params.sessionId, "sessionId"),
          request: body,
        });
        return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(response);
      } catch (error: unknown) {
        if (!(error instanceof TypeError)) throw error;
        return reply
          .code(400)
          .header("content-type", MOBILE_API_CONTENT_TYPE)
          .send({ code: "INVALID_REQUEST" });
      }
    },
  );

  app.post<{ Params: { attachmentId: string } }>(
    MOBILE_ATTACHMENT_BIND_PATH,
    async (request, reply) => {
      if (readHeader(request.headers.authorization) !== `Bearer ${debugBearerToken}`) {
        return reply
          .code(401)
          .header("content-type", MOBILE_API_CONTENT_TYPE)
          .send({ code: "UNAUTHENTICATED" });
      }

      try {
        const body = parseMobileAttachmentBindingRequest(request.body);
        const idempotencyKey = requireMobileIdempotencyKey(
          readHeader(request.headers["idempotency-key"]),
        );
        if (
          idempotencyKey !==
          `submission:${body.clientSubmissionId}:attachment:${body.clientAttachmentId}:bind:${body.leaseGeneration}`
        ) {
          throw new TypeError("Idempotency-Key does not match the attachment identity");
        }
        const response = await mobileAttachmentStore.bindAttachment({
          actorId: debugActorId,
          idempotencyKey,
          attachmentId: requireMobileUuid(request.params.attachmentId, "attachmentId"),
          request: body,
        });
        return reply.header("content-type", MOBILE_API_CONTENT_TYPE).send(response);
      } catch (error: unknown) {
        if (!(error instanceof TypeError)) throw error;
        return reply
          .code(400)
          .header("content-type", MOBILE_API_CONTENT_TYPE)
          .send({ code: "INVALID_REQUEST" });
      }
    },
  );

  return app;
}
