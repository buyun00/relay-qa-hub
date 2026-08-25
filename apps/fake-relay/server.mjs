import http from "node:http";
import { createHmac, randomUUID } from "node:crypto";

const HOST = process.env.QA_FAKE_RELAY_HOST || "127.0.0.1";
const PORT = parsePort(process.env.QA_FAKE_RELAY_PORT, 4321);
const MAX_BODY_BYTES = 256 * 1024;
const HANDOFF_PATH = "/api/fake-relay/v1/handoffs";
const CALLBACK_PATH = "/api/v1/integrations/relay/webhooks";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const callbackConfig = readCallbackConfig();
const callbackStats = { delivered: 0, failed: 0 };
let nextTaskId = 1;

/** @type {Map<string, { digest: string, response: object }>} */
const handoffs = new Map();

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, {
        status: "ok",
        service: "qa-hub-fake-relay",
        handoffs: handoffs.size,
        callback: {
          configured: callbackConfig !== null,
          delivered: callbackStats.delivered,
          failed: callbackStats.failed,
        },
      });
      return;
    }

    if (request.method === "POST" && request.url === HANDOFF_PATH) {
      const input = await readJson(request);
      const handoff = validateHandoff(input);
      const existing = handoffs.get(handoff.handoffId);
      if (existing && existing.digest !== handoff.payloadDigest) {
        sendJson(response, 409, {
          code: "IDEMPOTENCY_PAYLOAD_MISMATCH",
          handoffId: handoff.handoffId,
        });
        return;
      }

      if (existing) {
        sendJson(response, 202, { ...existing.response, replayed: true });
        return;
      }

      const receipt = {
        handoffId: handoff.handoffId,
        bugId: handoff.bugId,
        repairAttemptId: handoff.attemptId,
        relayInstanceId: "fake-relay-local",
        relayTaskId: `fake-${handoff.handoffId.slice(0, 8)}`,
        handoffStatus: "submitted",
        externalRevision: 1,
        lastEventAt: new Date().toISOString(),
        idempotencyKey: handoff.idempotencyKey,
        payloadDigest: handoff.payloadDigest,
        replayed: false,
      };
      handoffs.set(handoff.handoffId, {
        digest: handoff.payloadDigest,
        response: receipt,
      });
      if (callbackConfig !== null) {
        const taskId = nextTaskId++;
        const timer = setTimeout(() => {
          void deliverTurnDelivered(handoff, taskId);
        }, 400);
        timer.unref?.();
      }
      sendJson(response, 202, receipt);
      return;
    }

    sendJson(response, 404, { code: "NOT_FOUND" });
  } catch (error) {
    const status = error instanceof RequestError ? error.status : 400;
    const code = error instanceof RequestError ? error.code : "INVALID_REQUEST";
    sendJson(response, status, { code });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`fake Relay listening on http://${HOST}:${PORT}\n`);
});

function parsePort(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("QA_FAKE_RELAY_PORT must be a valid TCP port");
  }
  return port;
}

function readCallbackConfig() {
  const callbackUrl = process.env.QA_FAKE_RELAY_CALLBACK_URL;
  const webhookSecret = process.env.QA_FAKE_RELAY_WEBHOOK_SECRET;
  if (callbackUrl === undefined && webhookSecret === undefined) return null;
  if (!callbackUrl || !webhookSecret) {
    throw new Error(
      "QA_FAKE_RELAY_CALLBACK_URL and QA_FAKE_RELAY_WEBHOOK_SECRET must be provided together",
    );
  }
  const parsed = new URL(callbackUrl);
  if (
    parsed.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== CALLBACK_PATH ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "QA_FAKE_RELAY_CALLBACK_URL must be credential-free loopback HTTP with the frozen webhook path",
    );
  }
  return { url: parsed, secret: webhookSecret };
}

async function deliverTurnDelivered(handoff, taskId) {
  const eventId = randomUUID();
  const deliveryId = `fake-relay-local:event:${eventId}`;
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({
    schemaVersion: "1.0",
    relayInstanceId: "fake-relay-local",
    eventId,
    deliveryId,
    eventType: "turn.delivered",
    handoffId: handoff.handoffId,
    attemptId: handoff.attemptId,
    externalRevision: 2,
    occurredAt: new Date().toISOString(),
    payload: {
      taskId,
      turnId: 1,
      deliveryEvidence: {
        pushed: true,
        verified: true,
        commitSha: "f".repeat(40),
        remoteSha: "f".repeat(40),
        branch: "qa-hub/fake-delivery",
        mergeRequestUrl: null,
      },
    },
  });
  const signature = `sha256=${createHmac("sha256", callbackConfig.secret)
    .update(`${timestamp}.${body}`)
    .digest("hex")}`;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_500);
    try {
      const result = await fetch(callbackConfig.url, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "Idempotency-Key": deliveryId,
          "X-Relay-Delivery-Id": deliveryId,
          "X-Relay-Event-Id": eventId,
          "X-Relay-Timestamp": timestamp,
          "X-Relay-Signature": signature,
        },
        body,
        signal: controller.signal,
      });
      if (result.status >= 200 && result.status < 300) {
        callbackStats.delivered += 1;
        return;
      }
    } catch {
      // The callback is best-effort; only aggregate status is retained.
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < 2) await delay(100 * (attempt + 1));
  }
  callbackStats.failed += 1;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateHandoff(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError("INVALID_REQUEST");
  }
  const handoffId = requireUuid(value, "handoffId");
  const bugId = requireUuid(value, "bugId");
  const attemptId = requireUuid(value, "attemptId");
  const idempotencyKey = requiredString(value, "idempotencyKey");
  const payloadDigest = requiredString(value, "payloadDigest");
  if (!/^[0-9a-f]{64}$/.test(payloadDigest)) {
    throw new RequestError("INVALID_PAYLOAD_DIGEST");
  }
  return { handoffId, bugId, attemptId, idempotencyKey, payloadDigest };
}

function requiredString(value, key) {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0 || field.length > 512) {
    throw new RequestError(`INVALID_${key.toUpperCase()}`);
  }
  return field;
}

function requireUuid(value, key) {
  const field = requiredString(value, key);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(field)) {
    throw new RequestError(`INVALID_${key.toUpperCase()}`);
  }
  return field;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(request.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      reject(new RequestError("REQUEST_BODY_TOO_LARGE", 413));
      request.destroy();
      return;
    }

    const chunks = [];
    let total = 0;
    let rejected = false;
    request.on("data", (chunk) => {
      if (rejected) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        rejected = true;
        reject(new RequestError("REQUEST_BODY_TOO_LARGE", 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (rejected) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new RequestError("INVALID_JSON"));
      }
    });
    request.on("error", () => {
      if (!rejected) reject(new RequestError("REQUEST_READ_FAILED", 400));
    });
  });
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

class RequestError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
