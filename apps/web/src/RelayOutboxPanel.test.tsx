import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { SqliteStorageWorker, projectMembershipId } from "@relay-qa-hub/storage";
import { ProjectManagementService } from "../../api/dist/project-management.js";
import {
  ProjectComponentsRuntime,
  registerProjectComponentRoutes,
} from "../../api/dist/project-components-runtime.js";
import RelayOutboxPanel from "./RelayOutboxPanel";
import {
  listRelayOutbox,
  relayOutboxError,
  relayOutboxResumeReason,
  resumeRelayOutbox,
  type RelayOutboxItem,
} from "./relay-outbox-api";
import { setActiveProject } from "./project-context";
import { QaHubApiError } from "./api";

afterEach(() => {
  setActiveProject("");
  vi.unstubAllGlobals();
});
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

describe("project Relay outbox history", () => {
  it("uses real loopback API and SQLite for disabled, held and explicit resume without external requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qa-web-outbox-"));
    const accountId = randomUUID(),
      actorId = randomUUID(),
      projectId = randomUUID();
    const worker = new SqliteStorageWorker({
      databaseFile: join(directory, "qa.sqlite"),
      backupRoot: join(directory, "backups"),
      busyTimeoutMs: 1000,
      relayInstanceId: "fixture",
      qaInstanceId: "fixture-qa",
      relayPrincipalId: randomUUID(),
    });
    const app = Fastify();
    let runtime: ProjectComponentsRuntime | undefined;
    let externalRequests = 0;
    let held = true;
    try {
      const createdAt = new Date().toISOString();
      const scope = { accountId, actorId, projectId, createdAt };
      await worker.ensureMobileScope({
        ...scope,
        projectKey: "WEBQUEUE",
        actorDisplayName: "Web fixture",
        membershipId: projectMembershipId(projectId, actorId),
      });
      await worker.ensureMobileRelayRoles({
        ...scope,
        projectKey: "WEBQUEUE",
        actorDisplayName: "Web fixture",
        membershipId: projectMembershipId(projectId, actorId),
      });
      let componentVersion = 0;
      const setEnabled = async (enabled: boolean) =>
        worker.projectManagement({
          operation: "setComponent",
          accountId,
          actorId,
          isGm: true,
          projectId,
          componentKey: "relay.production",
          enabled,
          expectedVersion: componentVersion++,
          now: new Date().toISOString(),
          config: {
            baseUrl: "https://relay.fixture.invalid",
            externalProjectId: "WEBREMOTE",
            relayInstanceId: "fixture",
            credentialRef: "absent-fixture",
          },
        });
      await setEnabled(true);
      const created = await worker.createMobileBug({
        ...scope,
        clientSubmissionId: randomUUID(),
        payloadDigest: digest("create"),
        title: "Web outbox fixture",
        description: "Only local disposable evidence",
        expectedBehavior: "Selected project only",
        severity: "S2",
        priority: "P2",
        ownerId: actorId,
        verificationOwnerId: null,
        occurrence: {
          observedAt: createdAt,
          platform: "web",
          steps: ["fixture"],
          actualBehavior: "fixture",
        },
        attachmentIds: [],
        captureBundleId: null,
      });
      const ready = await worker.transitionMobileBugReady({
        ...scope,
        bugId: created.bug.id,
        expectedVersion: created.bug.version,
        idempotencyKey: randomUUID(),
        requestDigest: digest("ready"),
      });
      const attempt = await worker.createMobileRelayAttempt({
        ...scope,
        bugId: created.bug.id,
        expectedVersion: ready.version,
        assigneeId: actorId,
        summary: null,
        idempotencyKey: randomUUID(),
        requestDigest: digest("attempt"),
      });
      await worker.dispatchMobileRelay({
        ...scope,
        attemptId: attempt.id,
        expectedVersion: attempt.version,
        handoffId: randomUUID(),
        selectedAttachmentIds: [],
        idempotencyKey: randomUUID(),
        requestDigest: digest("dispatch"),
        relayInstanceId: "fixture",
        qaInstanceId: "fixture-qa",
        componentRoute: {
          componentVersion: 1,
          snapshotDigest: digest("snapshot"),
          externalProjectKey: "WEBREMOTE",
        },
      });
      await setEnabled(false);
      await worker.projectRelayQueue({
        operation: "pause",
        ...scope,
        now: new Date().toISOString(),
      });
      const management = new ProjectManagementService({ worker, accountId, gmUserId: actorId });
      runtime = new ProjectComponentsRuntime({
        root: join(directory, "runtime"),
        credentialRoot: join(directory, "credentials"),
        instanceId: "web-outbox-fixture",
        worker,
        management,
        executionHeld: () => held,
        uploaderExecutable: join(directory, "never-run.exe"),
        fetch: async () => {
          externalRequests++;
          throw new Error("Fixture forbids external HTTP");
        },
      });
      registerProjectComponentRoutes(app, {
        runtime,
        projectId: (request) => {
          const selected = (request.params as { projectId: string }).projectId;
          expect(request.headers["x-qa-project-id"]).toBe(selected);
          return selected;
        },
        actor: () => ({
          accountId,
          actorId,
          userId: actorId,
          email: "fixture@invalid",
          displayName: "Web fixture",
          csrfToken: "fixture",
          isGm: true,
        }),
      });
      const base = await app.listen({ host: "127.0.0.1", port: 0 });
      const realFetch = globalThis.fetch;
      const calls: { path: string; method: string; body: unknown }[] = [];
      vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
        const target = new URL(input, base);
        if (target.origin !== base) throw new Error("Only local fixture HTTP is permitted");
        calls.push({ path: target.pathname, method: init?.method ?? "GET", body: init?.body });
        return realFetch(target, init);
      });
      setActiveProject(projectId, actorId);
      const paused = await listRelayOutbox(projectId);
      const item = paused.items[0];
      expect(item).toBeDefined();
      if (!item) throw new Error("Fixture queue missing");
      expect(item.state).toBe("paused");
      expect(item.attemptCount).toBe(0);
      const render = (enabled: boolean, isHeld = false) =>
        renderToStaticMarkup(
          <RelayOutboxPanel
            projectId={projectId}
            items={[item]}
            enabled={enabled}
            held={isHeld}
            busy={false}
            onResume={() => undefined}
          />,
        );
      expect(render(false)).toContain("暂停原因");
      expect(render(false)).toContain('disabled=""');
      expect(render(false)).toContain(created.bug.id);
      expect(render(false)).toContain(item.handoffId);
      expect(render(false)).toContain("配置版本 1");
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
      held = false;
      await expect(resumeRelayOutbox(projectId, item)).rejects.toMatchObject({
        code: "COMPONENT_DISABLED",
      });
      await setEnabled(true);
      expect((await listRelayOutbox(projectId)).items[0]?.state).toBe("paused");
      expect(render(true)).not.toContain('disabled=""');
      held = true;
      await expect(resumeRelayOutbox(projectId, item)).rejects.toMatchObject({
        code: "IMPORT_EXECUTION_HELD",
      });
      expect((await listRelayOutbox(projectId)).items[0]?.state).toBe("paused");
      expect(render(true, true)).toContain("导入冻结");
      held = false;
      const resumed = await resumeRelayOutbox(projectId, item);
      expect(resumed.items[0]?.state).toBe("pending");
      expect(resumed.items[0]?.attemptCount).toBe(0);
      await expect(resumeRelayOutbox(projectId, item)).rejects.toMatchObject({
        code: "TASK_NOT_PAUSED",
      });
      expect(
        calls
          .filter((call) => call.method === "POST")
          .every(
            (call) =>
              call.path === `/api/v1/projects/${projectId}/production/outbox/${item.id}/resume` &&
              call.body === "{}",
          ),
      ).toBe(true);
      const audit = (await worker.projectManagement({
        operation: "audit",
        accountId,
        projectId,
        actorId,
        isGm: true,
        now: new Date().toISOString(),
      })) as { items: { action: string }[] };
      expect(audit.items.filter((entry) => entry.action === "relay.outbox.resumed")).toHaveLength(
        1,
      );
      expect(externalRequests).toBe(0);
    } finally {
      await app.close();
      await runtime?.close();
      await worker.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20000);

  it("rejects cross-project response and mutation, and ignores a late response after switching", async () => {
    const item = {
      id: "entry",
      projectId: "A",
      state: "paused",
      status: "pending",
      errorCode: "COMPONENT_DISABLED_PAUSED",
    } as RelayOutboxItem;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ projectId: "B", items: [] })));
    vi.stubGlobal("fetch", fetcher);
    setActiveProject("A", "employee");
    await expect(listRelayOutbox("A")).rejects.toMatchObject({ code: "OUTBOX_PROJECT_MISMATCH" });
    await expect(resumeRelayOutbox("B", item)).rejects.toMatchObject({
      code: "OUTBOX_PROJECT_MISMATCH",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    let respond: (value: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    const pending = listRelayOutbox("A");
    setActiveProject("B", "employee");
    respond(new Response(JSON.stringify({ projectId: "A", items: [item] })));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(relayOutboxResumeReason(item, "A", true, false)).toBe("");
    expect(relayOutboxResumeReason({ ...item, status: "sent" }, "A", true, false)).not.toBe("");
    expect(relayOutboxError(new QaHubApiError(409, "IMPORT_EXECUTION_HELD"))).toContain("尚未恢复");
  });
});
