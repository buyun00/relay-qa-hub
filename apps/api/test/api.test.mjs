import assert from "node:assert/strict";
import test from "node:test";

import {
  API_SERVICE_NAME,
  LIVE_HEALTH_PATH,
  createApiApp,
  createApiServer,
  resolveBuildSha,
} from "../dist/index.js";

const fixedTime = new Date("2026-08-24T08:00:00.000Z");
const buildSha = "a".repeat(40);

test("GET /api/v1/health/live returns the frozen liveness shape", async (t) => {
  const app = createApiApp({
    logger: false,
    version: "0.1.0-test",
    buildSha,
    now: () => fixedTime,
  });
  t.after(async () => app.close());

  const response = await app.inject({ method: "GET", url: LIVE_HEALTH_PATH });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: "ok",
    service: API_SERVICE_NAME,
    version: "0.1.0-test",
    buildSha,
    time: fixedTime.toISOString(),
  });
});

test("server defaults to loopback and supports graceful stop plus restart", async () => {
  const first = createApiServer({ logger: false });
  const firstAddress = await first.start({ port: 0 });
  assert.match(firstAddress, /^http:\/\/127\.0\.0\.1:\d+$/u);

  const liveResponse = await fetch(`${firstAddress}${LIVE_HEALTH_PATH}`);
  assert.equal(liveResponse.status, 200);
  await first.stop();
  await first.stop();

  const second = createApiServer({ logger: false });
  const secondAddress = await second.start({ port: 0 });
  assert.match(secondAddress, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.equal((await fetch(`${secondAddress}${LIVE_HEALTH_PATH}`)).status, 200);
  await second.stop();
});

test("rejects ambiguous build provenance", () => {
  assert.equal(resolveBuildSha(undefined), "dev");
  assert.throws(() => resolveBuildSha("ABC123"), /40-character lowercase Git SHA/u);
});
