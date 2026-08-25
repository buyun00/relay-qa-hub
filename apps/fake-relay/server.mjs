import http from "node:http";

const HOST = process.env.QA_FAKE_RELAY_HOST || "127.0.0.1";
const PORT = parsePort(process.env.QA_FAKE_RELAY_PORT, 4321);
const MAX_BODY_BYTES = 256 * 1024;
const HANDOFF_PATH = "/api/fake-relay/v1/handoffs";

/** @type {Map<string, { digest: string, response: object }>} */
const handoffs = new Map();

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, {
        status: "ok",
        service: "qa-hub-fake-relay",
        handoffs: handoffs.size,
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
