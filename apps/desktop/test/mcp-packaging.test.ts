import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_UPLOAD_PARAMETERS, UPLOAD_TARGETS } from "@relay-qa-hub/upload-contract";
import {
  QaHubMcpTools,
  QaHubMcpError,
  type QaHubApiTransport,
  type QaHubJsonRequest,
} from "../src/mcp-api.js";

const base = "/api/v1/increment-upload";
function fixture(response: (url: string, request?: QaHubJsonRequest) => unknown = () => ({})) {
  const calls: { url: string; request?: QaHubJsonRequest }[] = [];
  const api: QaHubApiTransport = {
    async json(url, request) {
      calls.push({ url, ...(request ? { request } : {}) });
      return response(url, request);
    },
    async binary() {
      throw new Error("MCP must not transfer ZIPs through the client");
    },
  };
  return { calls, tools: new QaHubMcpTools(api, "unused") };
}
test("one-click command uses shared defaults and reuses request ID without waiting for a build", async () => {
  const requestId = randomUUID();
  const f = fixture(() => ({ id: requestId, status: "queued" }));
  const result = (await f.tools.call("qa_build_and_upload", { requestId })) as Record<
    string,
    unknown
  >;
  await f.tools.call("qa_build_and_upload", { requestId });
  assert.equal(result["chainId"], requestId);
  assert.equal(result["accepted"], true);
  assert.equal(result["published"], undefined);
  assert.equal(f.calls[0]!.url, `${base}/build-chains`);
  assert.equal(f.calls[0]!.request?.headers?.["idempotency-key"], requestId);
  assert.deepEqual(f.calls[0], f.calls[1]);
  assert.deepEqual(f.calls[0]!.request?.body, {
    upload: {
      ...DEFAULT_UPLOAD_PARAMETERS,
      version: "",
      summary: "",
      description: "",
      testResultReference: "",
      mode: "publish_workflow",
    },
  });
});
test("iOS source, final-confirmation mode and version-only notes are explicit", async () => {
  const requestId = randomUUID(),
    f = fixture(() => requestId);
  await f.tools.call("qa_start_increment_upload", {
    requestId,
    platform: "ios",
    mode: "prepare_publish",
    version: "2.4.36",
    testerId: 12345,
  });
  const body = f.calls[0]!.request!.body as Record<string, unknown>;
  assert.equal(body["channelId"], UPLOAD_TARGETS.ios.channelId);
  assert.equal(body["belongName"], "[2002]Baloot Go|[2004]iOS");
  assert.equal(body["testerId"], 12345);
  assert.equal(body["mode"], "prepare_publish");
  assert.equal(body["summary"], "2.4.36");
  assert.equal(body["description"], "2.4.36");
});
test("all build presets and selected queue progress use the authenticated API", async () => {
  const f = fixture(() => ({ queueId: 123 }));
  for (const preset of ["external", "internal-sdk", "internal-nosdk"]) {
    await f.tools.call("qa_start_build", { requestId: randomUUID(), preset });
    assert.deepEqual(f.calls.at(-1)!.request!.body, { preset });
  }
  await f.tools.call("qa_get_packaging_status", {});
  assert.equal(f.calls.at(-1)!.url, "/api/v1/packaging");
  await f.tools.call("qa_get_packaging_status", { queueIds: [123, 124], buildNumbers: [99] });
  assert.equal(f.calls.at(-1)!.url, "/api/v1/packaging/progress?queues=123%2C124&builds=99");
});
test("shared chain status follows its upload ID and preserves publication evidence and permissions", async () => {
  const chainId = randomUUID(),
    jobId = randomUUID();
  const job = {
    id: jobId,
    canManage: false,
    status: "awaiting_publish",
    published: false,
    remoteStatus: 70,
  };
  const f = fixture((url) =>
    url.endsWith("/logs")
      ? { job, audit: [] }
      : url.endsWith("/build-chains")
        ? [{ id: chainId, status: "upload_started", uploadJobId: jobId }]
        : { jobs: [job], account: "private-account", configured: true, execution: "server" },
  );
  const result = (await f.tools.call("qa_get_increment_upload_status", {
    chainId,
    includeLogs: true,
  })) as Record<string, unknown>;
  assert.deepEqual(result["job"], job);
  assert.ok(result["logs"]);
  assert.equal(result["account"], undefined);
  assert.equal(result["published"], undefined);
  assert.equal(f.calls.at(-1)!.url, `${base}/jobs/${jobId}/logs`);
  await assert.rejects(f.tools.call("qa_get_increment_upload_status", { jobId: randomUUID() }), {
    code: "JOB_NOT_FOUND",
  });
});
test("resume and confirmation retain the existing task inputs, cancellation retains its scope", async () => {
  const jobId = randomUUID(),
    requestId = randomUUID(),
    f = fixture(() => jobId);
  for (const [name, route] of [
    ["qa_resume_increment_upload", "resume"],
    ["qa_confirm_increment_publish", "confirm-publish"],
  ]) {
    await f.tools.call(name!, { jobId, requestId });
    assert.deepEqual(f.calls.at(-1), {
      url: `${base}/jobs/${jobId}/${route}`,
      request: { method: "POST", body: {}, headers: { "idempotency-key": requestId } },
    });
  }
  await f.tools.call("qa_cancel_increment_upload", { jobId });
  assert.equal(f.calls.at(-1)!.url, `${base}/jobs/${jobId}/cancel`);
  await f.tools.call("qa_cancel_build_upload", { chainId: jobId });
  assert.equal(f.calls.at(-1)!.url, `${base}/build-chains/${jobId}/cancel`);
});
test("invalid, ambiguous and unsupported arguments are rejected before any API writes", async () => {
  const requestId = randomUUID(),
    f = fixture();
  for (const [name, args] of [
    ["qa_build_and_upload", {}],
    ["qa_build_and_upload", { requestId, platform: "ios" }],
    ["qa_build_and_upload", { requestId, url: "https://elsewhere.test" }],
    ["qa_build_and_upload", { requestId, mode: "upload_only" }],
    ["qa_start_increment_upload", { requestId, testerId: 0 }],
    ["qa_start_increment_upload", { requestId, testerId: null }],
    ["qa_start_increment_upload", { requestId, version: null }],
    ["qa_start_increment_upload", { requestId, version: "../file" }],
    ["qa_start_build", { requestId: "../../file" }],
    ["qa_get_packaging_status", { queueIds: [1, 1] }],
    ["qa_get_increment_upload_status", { jobId: requestId, chainId: requestId }],
    ["qa_get_increment_upload_status", { includeLogs: true }],
    ["qa_resume_increment_upload", { requestId, jobId: requestId, testerId: 2 }],
  ] as const)
    await assert.rejects(f.tools.call(name, args), { code: "INVALID_ARGUMENTS" });
  assert.equal(f.calls.length, 0);
});
test("backend auth, ownership and uncertain-submission errors pass through without automatic retries", async () => {
  for (const code of [
    "AUTH_REQUIRED",
    "JOB_NOT_FOUND",
    "UPLOAD_CHANNEL_HELD",
    "JENKINS_SUBMISSION_UNKNOWN",
  ]) {
    const f = fixture(() => {
      throw new QaHubMcpError(code, "Rejected", 409);
    });
    await assert.rejects(f.tools.call("qa_build_and_upload", { requestId: randomUUID() }), {
      code,
    });
    assert.equal(f.calls.length, 1);
  }
});
test("MCP definitions distinguish reads, external writes and ordinary build retry limits", () => {
  const f = fixture();
  assert.equal(f.tools.definitions.length, 27);
  assert.equal(new Set(f.tools.definitions.map((t) => t.name)).size, 27);
  assert.equal(
    f.tools.definitions.find((t) => t.name === "qa_get_packaging_status")!.annotations.readOnlyHint,
    true,
  );
  assert.equal(
    f.tools.definitions.find((t) => t.name === "qa_build_and_upload")!.annotations.idempotentHint,
    true,
  );
  assert.equal(
    f.tools.definitions.find((t) => t.name === "qa_start_build")!.annotations.idempotentHint,
    false,
  );
});
