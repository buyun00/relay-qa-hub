import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";

import { API_SERVICE_NAME, API_VERSION, DEVELOPMENT_BUILD_SHA, resolveBuildSha } from "./config.js";
import {
  MAX_MOBILE_CHUNK_SIZE_BYTES,
  MOBILE_ATTACHMENT_BIND_PATH,
  MOBILE_UPLOAD_CHUNK_PATH,
  MOBILE_UPLOAD_FINALIZE_PATH,
  MOBILE_UPLOAD_INIT_PATH,
  type MobileAttachmentStore,
  parseMobileAttachmentBindingRequest,
  parseMobileChunkNumber,
  parseMobileFinalizeUploadRequest,
  parseMobileInitUploadRequest,
  parseStrongUploadVersion,
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
} from "./mobile-bugs.js";
import {
  MOBILE_CAPTURE_COLLECTION_PATH,
  MOBILE_CAPTURE_ITEM_PATH,
  MobileCaptureRequestError,
  parseMobileCreateCaptureRequest,
  type MobileCaptureStore,
} from "./mobile-captures.js";
import {
  MOBILE_BUG_REPAIR_ATTEMPTS_PATH,
  MOBILE_BUG_TRANSITION_PATH,
  MOBILE_RELAY_DISPATCH_PATH,
  MOBILE_RELAY_RECEIPT_PATH,
  parseMobileBugReadyRequest,
  parseMobileRelayAttemptRequest,
  parseMobileRelayDispatchRequest,
  requireRelayIdempotencyKey,
  requireRelayUuid,
  type MobileRelayStore,
} from "./mobile-relay.js";

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
  getBug: () => null,
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
  dispatchRelay: () => {
    throw new Error("MobileRelayStore is not configured");
  },
  getRelayReceipt: () => null,
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
  const debugBearerToken = options.debugBearerToken ?? DEFAULT_DEBUG_BEARER_TOKEN;
  const debugActorId = options.debugActorId ?? DEFAULT_DEBUG_ACTOR_ID;

  if (debugBearerToken.length === 0) throw new Error("debugBearerToken must not be empty");

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

  const relayErrorReply = (
    error: unknown,
    reply: FastifyReply,
  ) => {
    const code = (error as { code?: unknown })?.code;
    if (code === "NOT_FOUND") {
      return reply.code(404).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
    }
    if (code === "VERSION_CONFLICT" || code === "IDEMPOTENCY_PAYLOAD_MISMATCH") {
      return reply.code(409).header("content-type", MOBILE_API_CONTENT_TYPE).send({ code });
    }
    if (error instanceof TypeError || code === "INVALID_REQUEST") {
      return reply.code(400).header("content-type", MOBILE_API_CONTENT_TYPE).send({
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
        const body = parseMobileRelayAttemptRequest(request.body);
        const idempotencyKey = requireRelayIdempotencyKey(
          readHeader(request.headers["idempotency-key"]),
        );
        if (
          idempotencyKey !==
          `workflow:createRepairAttempt:bug:${bugId}:v${body.expectedVersion}`
        ) {
          throw new TypeError("Idempotency-Key does not match RepairAttempt creation");
        }
        const result = await mobileRelayStore.createRelayAttempt({
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

  app.get<{ Params: { attemptId: string } }>(
    MOBILE_RELAY_RECEIPT_PATH,
    async (request, reply) => {
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
      if (idempotencyKey !== `submission:${body.clientSubmissionId}:capture:${body.capture.captureId}`) {
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
      return reply
        .code(201)
        .header("content-type", MOBILE_API_CONTENT_TYPE)
        .send(response);
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
