import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { QaHubMcpTools, type QaHubApiTransport, type QaHubJsonRequest } from "../src/mcp-api.js";

test("the existing MCP exposes batch production and keeps all eight canonical bug IDs", async () => {
  const calls: { url: string; request?: QaHubJsonRequest }[] = [];
  const api: QaHubApiTransport = {
    async json(url, request) {
      calls.push({ url, ...(request ? { request } : {}) });
      return { id: "batch-1", status: "running" };
    },
    async binary() {
      throw new Error("unexpected binary request");
    },
  };
  const mcp = new QaHubMcpTools(api, "unused");
  assert.ok(mcp.definitions.some((tool) => tool.name === "qa_list_bugs"));
  assert.ok(mcp.definitions.some((tool) => tool.name === "qa_start_relay_batch"));
  const bugs = Array.from({ length: 8 }, (_, index) => ({
    bugId: `bug-${index}`,
    selectedAttachmentIds: [`proof-${index}`],
  }));
  await mcp.call("qa_start_relay_batch", { projectId: "project-1", requestId: "eight", bugs });
  const body = calls[0]!.request!.body as { items: unknown[]; kind: string; requestId: string };
  assert.deepEqual(body.items, bugs);
  assert.equal(body.kind, "bugs");
  assert.equal(body.requestId, "eight");
  assert.equal(calls[0]!.url, "/api/v1/production/batches");
});
test("MCP file upload is bounded and the task command carries IDs rather than local paths", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "qa-mcp-production-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "proof.txt");
  await writeFile(file, "evidence");
  const calls: { url: string; body: unknown }[] = [];
  const api: QaHubApiTransport = {
    async json(url, request) {
      calls.push({ url, body: request?.body });
      return { id: url.endsWith("/uploads") ? "upload-1" : "batch-1" };
    },
    async binary() {
      throw new Error("unexpected binary request");
    },
  };
  await new QaHubMcpTools(api, root).call("qa_create_relay_task", {
    projectId: "project-1",
    requestId: "new-1",
    title: "Fix",
    message: "Fix with proof",
    filePaths: [file],
  });
  assert.equal(calls[0]!.url, "/api/v1/production/uploads");
  const body = calls[1]!.body as { items: { uploadIds: string[] }[] };
  assert.deepEqual(body.items[0]!.uploadIds, ["upload-1"]);
  assert.equal(JSON.stringify(body).includes(root), false);
  await assert.rejects(
    new QaHubMcpTools(api, root).call("qa_create_relay_task", {
      projectId: "project-1",
      requestId: "new-2",
      title: "Fix",
      message: "Fix",
      filePaths: ["relative.txt"],
    }),
    { code: "INVALID_ATTACHMENT" },
  );
});
