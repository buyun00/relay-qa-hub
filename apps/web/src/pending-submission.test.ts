import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pendingSubmissions,
  type BugSubmissionDraft,
  type SubmissionJournal,
  type SubmissionScope,
  type SubmissionStore,
} from "./pending-submission";
import { setActiveProject, setServiceIdentity } from "./project-context";
import { setBrowserCsrfToken, uploadBugCreateAttachment } from "./api";

const scope: SubmissionScope = {
  accountId: "account-a",
  projectId: "project-a",
  actorId: "actor-a",
};
function clone<T>(value: T): T {
  if (value instanceof File)
    return new File([value], value.name, {
      type: value.type,
      lastModified: value.lastModified,
    }) as T;
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) as T;
  return value;
}
function storage() {
  const records = new Map<string, SubmissionJournal>();
  let tail = Promise.resolve();
  let fail: (next: SubmissionJournal) => boolean = () => false;
  const store: SubmissionStore = (key, update) => {
    const operation = tail.then(() => {
      const next = update(clone(records.get(key)));
      if (fail(next)) throw new Error("disk full");
      records.set(key, clone(next));
      return clone(next);
    });
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
  return {
    store,
    records,
    failWhen: (predicate: typeof fail) => {
      fail = predicate;
    },
  };
}
function draft(content = "原问题"): BugSubmissionDraft {
  return {
    content,
    title: content,
    expectedBehavior: "修复问题",
    severity: "S2",
    ownerId: "",
    verificationOwnerId: "actor-a",
    files: [new File(["abcdef"], "evidence.png", { type: "image/png", lastModified: 100 })],
  };
}
type Stage = "init" | "chunk" | "finalize" | "bind" | "create" | "comment";
function server(drop?: Stage) {
  const requests: { stage: Stage; key: string; body: string; project: string | null }[] = [];
  const effects = { bugs: 0, comments: 0 };
  const receipts = new Map<string, { signature: string; response: Response }>();
  let discarded = false;
  let activeScope = scope;
  let afterResponse: (() => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const key = headers.get("Idempotency-Key") ?? "";
      const raw =
        typeof init.body === "string"
          ? init.body
          : init.body instanceof Blob
            ? Buffer.from(await init.body.arrayBuffer()).toString("hex")
            : "";
      const body =
        typeof init.body === "string" ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const stage: Stage = path.endsWith("/init")
        ? "init"
        : path.includes("/chunks/")
          ? "chunk"
          : path.endsWith("/finalize")
            ? "finalize"
            : path.endsWith("/bind")
              ? "bind"
              : path.endsWith("/comments")
                ? "comment"
                : "create";
      const signature = JSON.stringify([
        path,
        raw,
        headers.get("if-match"),
        headers.get("x-qa-project-id"),
        headers.get("content-type"),
      ]);
      requests.push({ stage, key, body: raw, project: headers.get("x-qa-project-id") });
      expect(headers.get("x-qa-project-id")).toBe(activeScope.projectId);
      let stored = receipts.get(key);
      if (!stored) {
        let response: Response;
        if (stage === "init")
          response = Response.json({
            sessionId: `session-${receipts.size}`,
            chunkSize: 3,
            version: 1,
          });
        else if (stage === "chunk")
          response = new Response(null, {
            status: 200,
            headers: { "x-upload-version": String(Number(path.split("/").at(-1)) + 2) },
          });
        else if (stage === "finalize")
          response = Response.json({
            attachmentId: `attachment-${body.clientAttachmentId}`,
            readyToBind: true,
            version: 4,
          });
        else if (stage === "bind") response = Response.json({ status: "reserved", version: 5 });
        else if (stage === "create") {
          effects.bugs++;
          response = Response.json({
            clientSubmissionId: body.clientSubmissionId,
            bug: {
              id: `bug-${body.clientSubmissionId}`,
              projectId: body.projectId,
              reporterId: activeScope.actorId,
            },
            qaItem: { id: `bug-${body.clientSubmissionId}` },
            attachmentIds: body.attachmentIds,
          });
        } else {
          effects.comments++;
          response = Response.json({
            correlationId: body.clientSubmissionId,
            comment: {
              id: `comment-${body.clientSubmissionId}`,
              clientSubmissionId: body.clientSubmissionId,
              bugId: decodeURIComponent(path.split("/").at(-2) ?? ""),
              authorId: activeScope.actorId,
              body: body.body,
            },
          });
        }
        stored = { signature, response };
        receipts.set(key, stored);
      }
      expect(signature).toBe(stored.signature);
      afterResponse?.();
      if (stage === drop && !discarded) {
        discarded = true;
        throw new TypeError("response lost after effect");
      }
      return stored.response.clone();
    }),
  );
  return {
    requests,
    effects,
    setScope: (next: SubmissionScope) => {
      activeScope = next;
    },
    after: (callback: () => void) => {
      afterResponse = callback;
    },
  };
}

beforeEach(() => {
  setServiceIdentity("http://independent-preview.test");
  setActiveProject(scope.projectId, scope.actorId);
  vi.stubGlobal("navigator", { userAgent: "browser-before-restart", platform: "Windows" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setBrowserCsrfToken(null);
});

describe("durable Bug and comment intent", () => {
  it("blocks core POST when the durable attempt marker cannot commit", async () => {
    const db = storage();
    const remote = server();
    db.failWhen((journal) => (journal.entries.at(-1)?.commitAttempts ?? 0) > 0);
    const client = pendingSubmissions(db.store);
    await expect(client.bug(scope, draft())).rejects.toThrow("disk full");
    await expect(client.comment(scope, "bug-a", "text")).rejects.toThrow("disk full");
    expect(
      remote.requests.some((request) => request.stage === "create" || request.stage === "comment"),
    ).toBe(false);
    db.failWhen(() => false);
    await client.bug(scope, draft());
    await client.comment(scope, "bug-a", "text");
    expect(remote.effects).toEqual({ bugs: 1, comments: 1 });
  });

  it.each([403, 409, 500])("never releases a core HTTP %s outcome", async (status) => {
    const db = storage();
    vi.stubGlobal("fetch", async () => Response.json({ code: "INVALID_REQUEST" }, { status }));
    const client = pendingSubmissions(db.store);
    await expect(client.comment(scope, "bug-a", "text")).rejects.toThrow();
    expect(await client.rejection(scope, "bug-a")).toBeUndefined();
    const id = [...db.records.values()][0]?.entries[0]?.id;
    await expect(client.comment(scope, "bug-a", "changed", undefined, false, id)).rejects.toThrow(
      "拒绝记录已变化",
    );
  });
  it.each(["upload", "bug", "comment"] as const)(
    "requires explicit replacement after a definite first %s rejection, retaining the original",
    async (phase) => {
      const db = storage();
      const remote = server();
      const originalFetch = globalThis.fetch;
      let rejected = false;
      vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
        const path = String(args[0]);
        const matches =
          phase === "upload"
            ? path.endsWith("/finalize")
            : phase === "bug"
              ? path === "/api/v1/bugs"
              : path.endsWith("/comments");
        if (matches && !rejected) {
          rejected = true;
          return Response.json(
            { code: phase === "upload" ? "UPLOAD_CONTENT_INVALID" : "INVALID_REQUEST" },
            { status: 400 },
          );
        }
        return originalFetch(...args);
      });
      const client = pendingSubmissions(db.store);
      if (phase === "comment")
        await expect(client.comment(scope, "bug-a", "bad")).rejects.toThrow();
      else await expect(client.bug(scope, draft("bad"))).rejects.toThrow();
      const rejection = await client.rejection(scope, phase === "comment" ? "bug-a" : undefined);
      expect(rejection?.phase).toBe(phase === "upload" ? "upload" : "commit");
      const count = remote.requests.length;
      if (phase === "comment")
        await expect(client.comment(scope, "bug-a", "fixed")).rejects.toThrow("明确拒绝");
      else await expect(client.bug(scope, draft("fixed"))).rejects.toThrow("明确拒绝");
      expect(remote.requests).toHaveLength(count);
      const result =
        phase === "comment"
          ? await client.comment(scope, "bug-a", "fixed", undefined, false, rejection?.id)
          : await client.bug(scope, draft("fixed"), undefined, false, rejection?.id);
      expect(result.receiptId).not.toBe(rejection?.id);
      expect(remote.effects).toEqual({
        bugs: phase === "comment" ? 0 : 1,
        comments: phase === "comment" ? 1 : 0,
      });
      const journal = [...db.records.values()][0];
      expect(journal?.entries).toHaveLength(2);
      expect(journal?.entries[0]?.rejection).toEqual(rejection);
      expect(journal?.entries[0]?.supersededBy).toBe(result.receiptId);
      const old = journal?.entries[0];
      if (old?.kind === "bug") expect(await old.draft.files[0]?.text()).toBe("abcdef");
    },
  );

  it.each(["create", "comment"] as const)(
    "never releases a lost %s result because a later replay returns 400",
    async (stage) => {
      const db = storage();
      const remote = server(stage);
      const client = pendingSubmissions(db.store);
      const originalFetch = globalThis.fetch;
      const submit = () =>
        stage === "create" ? client.bug(scope, draft()) : client.comment(scope, "bug-a", "text");
      await expect(submit()).rejects.toThrow("response lost");
      vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
        const path = String(args[0]);
        if (stage === "create" ? path === "/api/v1/bugs" : path.endsWith("/comments"))
          return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
        return originalFetch(...args);
      });
      await expect(submit()).rejects.toThrow();
      const entry = [...db.records.values()][0]?.entries[0];
      expect(entry?.commitAttempts).toBe(2);
      expect(entry?.rejection).toBeUndefined();
      if (stage === "create")
        await expect(
          client.bug(scope, draft("fixed"), undefined, false, entry?.id),
        ).rejects.toThrow("拒绝记录已变化");
      else
        await expect(
          client.comment(scope, "bug-a", "fixed", undefined, false, entry?.id),
        ).rejects.toThrow("拒绝记录已变化");
      expect(remote.effects).toEqual({
        bugs: stage === "create" ? 1 : 0,
        comments: stage === "comment" ? 1 : 0,
      });
    },
  );

  it("does not release an upload rejection until the rejection evidence itself commits", async () => {
    const db = storage();
    server();
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) =>
      String(args[0]).endsWith("/finalize")
        ? Response.json({ code: "UPLOAD_CONTENT_INVALID" }, { status: 400 })
        : originalFetch(...args),
    );
    db.failWhen((journal) => !!journal.entries.at(-1)?.rejection);
    const client = pendingSubmissions(db.store);
    await expect(client.bug(scope, draft())).rejects.toThrow("disk full");
    db.failWhen(() => false);
    expect(await client.rejection(scope)).toBeUndefined();
    const id = [...db.records.values()][0]?.entries[0]?.id;
    await expect(client.bug(scope, draft("fixed"), undefined, false, id)).rejects.toThrow(
      "拒绝记录已变化",
    );
  });

  it("accepts equal current upload versions on duplicate chunks from another window", async () => {
    const db = storage();
    server();
    const client = pendingSubmissions(db.store);
    await client.bug(scope, draft());
    const entry = [...db.records.values()][0]?.entries[0];
    if (entry?.kind !== "bug" || !entry.uploads[0]?.init)
      throw new Error("missing original upload");
    const requests: RequestInit[] = [];
    vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
      requests.push(init);
      if (path.includes("/chunks/"))
        return new Response(null, { status: 204, headers: { "x-upload-version": "4" } });
      if (path.endsWith("/finalize")) return Response.json(entry.uploads[0]?.finalized);
      return Response.json({ status: "reserved", version: 5 });
    });
    const result = await uploadBugCreateAttachment({
      projectId: scope.projectId,
      clientSubmissionId: entry.id,
      file: draft().files[0] as File,
      checkpoint: {
        clientAttachmentId: entry.uploads[0].clientAttachmentId,
        sha256: entry.uploads[0].sha256,
        nextChunk: 0,
        version: 1,
        init: entry.uploads[0].init,
      },
      saveCheckpoint: async () => undefined,
    });
    expect(result).toBe(entry.uploads[0].finalized?.attachmentId);
    expect(
      requests
        .filter((request) => request.method === "PUT")
        .map((request) => new Headers(request.headers).get("If-Match")),
    ).toEqual(['"1"', '"4"']);
  });
  it("keeps the original identity after a successful response with mismatched ownership", async () => {
    const db = storage();
    const remote = server();
    const transportFetch = globalThis.fetch;
    let corrupted = false;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      const response = await transportFetch(...args);
      if (String(args[0]) === "/api/v1/bugs" && !corrupted) {
        corrupted = true;
        const body = (await response.json()) as { bug: { reporterId: string } };
        return Response.json({ ...body, bug: { ...body.bug, reporterId: "wrong-actor" } });
      }
      return response;
    });
    await expect(pendingSubmissions(db.store).bug(scope, draft())).rejects.toThrow("归属不一致");
    const result = await pendingSubmissions(db.store).bug(scope, draft("edited"));
    expect(result.matchesDraft).toBe(false);
    expect(remote.effects.bugs).toBe(1);
    expect(
      new Set(
        remote.requests
          .filter((request) => request.stage === "create")
          .map((request) => request.key),
      ).size,
    ).toBe(1);
  });
  it("acknowledges a durable receipt before submitting edited text after a pre-UI crash", async () => {
    const db = storage();
    const remote = server();
    const crashed = pendingSubmissions(db.store);
    const original = await crashed.bug(scope, draft()); // durable response; UI never sees it
    const restored = pendingSubmissions(db.store);
    const edited = draft("new text saved before the crash");
    const recovered = await restored.bug(scope, edited);
    expect(recovered.receiptId).toBe(original.receiptId);
    expect(recovered.matchesDraft).toBe(false);
    expect(remote.effects.bugs).toBe(1);
    await restored.bug(scope, edited, recovered.receiptId); // next explicit click
    expect(remote.effects.bugs).toBe(2);
    const priorComment = await crashed.comment(scope, "bug-a", "original");
    const comment = await restored.comment(scope, "bug-a", "edited before crash");
    expect(comment.receiptId).toBe(priorComment.receiptId);
    expect(comment.matchesDraft).toBe(false);
    expect(remote.effects.comments).toBe(1);
    await restored.comment(scope, "bug-a", "edited before crash", comment.receiptId);
    expect(remote.effects.comments).toBe(2);
  });

  it("exposes an unacknowledged successful result for confirmation even beside an empty restored form", async () => {
    const db = storage();
    server();
    const client = pendingSubmissions(db.store);
    const receipt = await client.bug(scope, draft());
    expect(await client.recoverBug(scope)).toBeDefined();
    const empty = { ...draft(""), files: [], verificationOwnerId: "" };
    const confirm = await client.bug(scope, empty, undefined, true);
    expect(confirm.receiptId).toBe(receipt.receiptId);
    expect(confirm.matchesDraft).toBe(false);
    expect(await client.recoverBug(scope, confirm.receiptId)).toBeUndefined();
    const comment = await client.comment(scope, "bug-a", "original");
    expect(await client.recoverComment(scope, "bug-a")).toBe("original");
    const commentConfirm = await client.comment(scope, "bug-a", "", undefined, true);
    expect(commentConfirm.receiptId).toBe(comment.receiptId);
    expect(commentConfirm.matchesDraft).toBe(false);
    expect(await client.recoverComment(scope, "bug-a", commentConfirm.receiptId)).toBeUndefined();
  });
  it("resolves original submissions while keeping a deliberately blank later draft", async () => {
    const db = storage();
    const remote = server("create");
    const client = pendingSubmissions(db.store);
    await expect(client.bug(scope, draft())).rejects.toThrow();
    const cleared = { ...draft(""), files: [], verificationOwnerId: "" };
    const result = await pendingSubmissions(db.store).bug(scope, cleared, undefined, true);
    expect(result.matchesDraft).toBe(false);
    expect(remote.effects.bugs).toBe(1);
    const before = remote.requests.length;
    await expect(client.comment(scope, "no-pending-bug", "", undefined, true)).rejects.toThrow(
      "没有待确认",
    );
    expect(remote.requests).toHaveLength(before);
  });

  it("keeps replaced image bytes even when name, MIME, size and timestamp are identical", async () => {
    const db = storage();
    const remote = server("create");
    const original = draft();
    await expect(pendingSubmissions(db.store).bug(scope, original)).rejects.toThrow();
    const edited = {
      ...original,
      files: [new File(["ghijkl"], "evidence.png", { type: "image/png", lastModified: 100 })],
    };
    const result = await pendingSubmissions(db.store).bug(scope, edited);
    expect(result.matchesDraft).toBe(false);
    expect(remote.effects.bugs).toBe(1);
    expect(await edited.files[0]?.text()).toBe("ghijkl");
  });

  it("finds an old window's receipt even after a newer different submission completed", async () => {
    const db = storage();
    const remote = server();
    const client = pendingSubmissions(db.store);
    const first = await client.bug(scope, draft());
    await client.bug(scope, draft("next"), first.receiptId);
    const stale = await pendingSubmissions(db.store).bug(scope, draft());
    expect(stale.receiptId).toBe(first.receiptId);
    const comment = await client.comment(scope, "bug-a", "first");
    await client.comment(scope, "bug-a", "next", comment.receiptId);
    const staleComment = await pendingSubmissions(db.store).comment(scope, "bug-a", "first");
    expect(staleComment.receiptId).toBe(comment.receiptId);
    expect(remote.effects).toEqual({ bugs: 2, comments: 2 });
  });
  it.each(["init", "chunk", "finalize", "bind", "create"] as const)(
    "reopens after a lost %s response and replays frozen bytes, IDs and occurrence",
    async (stage) => {
      const db = storage();
      const remote = server(stage);
      const original = draft();
      await expect(pendingSubmissions(db.store).bug(scope, original)).rejects.toThrow(
        "response lost",
      );
      const pending = await pendingSubmissions(db.store).recoverBug(scope);
      expect(pending?.content).toBe(original.content);
      expect(await pending?.files[0]?.text()).toBe("abcdef");
      vi.stubGlobal("navigator", {
        userAgent: "different browser after restart",
        platform: "Other OS",
      });
      const result = await pendingSubmissions(db.store).bug(scope, draft("用户后来改的文字"));
      expect(result.matchesDraft).toBe(false);
      expect(remote.effects.bugs).toBe(1);
      expect(
        new Set(
          remote.requests
            .filter((request) => request.stage === "init")
            .map((request) => request.key),
        ).size,
      ).toBe(1);
      const commit = remote.requests.find((request) => request.stage === "create");
      expect(JSON.parse(commit?.body ?? "{}").occurrence.deviceModel).toBe(
        "browser-before-restart",
      );
      const before = remote.requests.length;
      const staleRestored = await pendingSubmissions(db.store).bug(scope, original);
      expect(staleRestored.receiptId).toBe(result.receiptId);
      expect(remote.requests).toHaveLength(before);
      expect(staleRestored.matchesDraft).toBe(true);
    },
  );

  it("recovers an unknown comment with the original body and key, preserving an edited draft", async () => {
    const db = storage();
    const remote = server("comment");
    await expect(pendingSubmissions(db.store).comment(scope, "bug-a", "原评论")).rejects.toThrow();
    expect(await pendingSubmissions(db.store).recoverComment(scope, "bug-a")).toBe("原评论");
    const result = await pendingSubmissions(db.store).comment(scope, "bug-a", "之后编辑的评论");
    expect(result.matchesDraft).toBe(false);
    expect(remote.effects.comments).toBe(1);
    expect(new Set(remote.requests.map((request) => request.key)).size).toBe(1);
    expect(new Set(remote.requests.map((request) => request.body)).size).toBe(1);
  });

  it("serializes two window claims into one business identity for create and comment", async () => {
    const db = storage();
    const remote = server();
    const clients = [pendingSubmissions(db.store), pendingSubmissions(db.store)];
    const bugs = await Promise.all(clients.map((client) => client.bug(scope, draft())));
    expect(bugs[0]?.receiptId).toBe(bugs[1]?.receiptId);
    const comments = await Promise.all(
      clients.map((client) => client.comment(scope, "bug-a", "同一评论")),
    );
    expect(comments[0]?.receiptId).toBe(comments[1]?.receiptId);
    expect(remote.effects).toEqual({ bugs: 1, comments: 1 });
  });

  it("blocks all network when the initial durable claim fails", async () => {
    const db = storage();
    const remote = server();
    db.failWhen(() => true);
    await expect(pendingSubmissions(db.store).bug(scope, draft())).rejects.toThrow("disk full");
    await expect(pendingSubmissions(db.store).comment(scope, "bug-a", "comment")).rejects.toThrow(
      "disk full",
    );
    expect(remote.requests).toHaveLength(0);
    expect(db.records.size).toBe(0);
  });

  it.each(["init", "chunk", "finalize", "bind", "create"] as const)(
    "halts after %s if its checkpoint cannot commit and safely replays it",
    async (stage) => {
      const db = storage();
      const remote = server();
      db.failWhen((journal) => {
        const entry = journal.entries.at(-1);
        if (entry?.kind !== "bug") return false;
        const upload = entry.uploads[0];
        return stage === "init"
          ? !!upload?.init
          : stage === "chunk"
            ? (upload?.nextChunk ?? 0) > 0
            : stage === "finalize"
              ? !!upload?.finalized
              : stage === "bind"
                ? !!upload?.bound
                : !!entry.response;
      });
      await expect(pendingSubmissions(db.store).bug(scope, draft())).rejects.toThrow("disk full");
      expect(remote.requests.at(-1)?.stage).toBe(stage);
      db.failWhen(() => false);
      await pendingSubmissions(db.store).bug(scope, draft());
      expect(remote.effects.bugs).toBe(1);
    },
  );

  it("retains a comment whose response arrived but receipt persistence failed", async () => {
    const db = storage();
    const remote = server();
    db.failWhen((journal) => !!journal.entries.at(-1)?.response);
    await expect(pendingSubmissions(db.store).comment(scope, "bug-a", "text")).rejects.toThrow(
      "disk full",
    );
    db.failWhen(() => false);
    await pendingSubmissions(db.store).comment(scope, "bug-a", "text");
    expect(remote.effects.comments).toBe(1);
    expect(new Set(remote.requests.map((request) => request.key)).size).toBe(1);
  });

  it("allows an explicitly acknowledged next identical submission, retaining both receipts", async () => {
    const db = storage();
    const remote = server();
    const client = pendingSubmissions(db.store);
    const first = await client.bug(scope, draft());
    const next = await client.bug(scope, draft(), first.receiptId);
    expect(next.receiptId).not.toBe(first.receiptId);
    const comment = await client.comment(scope, "bug-a", "same");
    await client.comment(scope, "bug-a", "same", comment.receiptId);
    expect(remote.effects).toEqual({ bugs: 2, comments: 2 });
    expect([...db.records.values()].map((journal) => journal.entries.length)).toEqual([2, 2]);
  });

  it("isolates actor, project, account, service and comment target", async () => {
    const db = storage();
    const remote = server();
    const client = pendingSubmissions(db.store);
    const scopes = [
      scope,
      { ...scope, actorId: "actor-b" },
      { ...scope, projectId: "project-b" },
      { ...scope, accountId: "account-b" },
    ];
    for (const identity of scopes) {
      remote.setScope(identity);
      setActiveProject(identity.projectId, identity.actorId);
      await client.comment(identity, "bug-a", "same");
    }
    remote.setScope(scope);
    setActiveProject(scope.projectId, scope.actorId);
    await client.comment(scope, "bug-b", "same");
    setServiceIdentity("http://another-preview.test");
    await client.comment(scope, "bug-a", "same");
    expect(remote.effects.comments).toBe(6);
    expect(db.records.size).toBe(6);
  });

  it("stops the original request after a project switch and can resume after returning", async () => {
    const db = storage();
    const remote = server();
    let switched = false;
    remote.after(() => {
      if (!switched) {
        switched = true;
        setActiveProject("project-b", "actor-b");
      }
    });
    await expect(pendingSubmissions(db.store).bug(scope, draft())).rejects.toThrow("项目已切换");
    expect(remote.requests).toHaveLength(1);
    expect(remote.effects.bugs).toBe(0);
    setActiveProject(scope.projectId, scope.actorId);
    await pendingSubmissions(db.store).bug(scope, draft());
    expect(remote.effects.bugs).toBe(1);
    expect(remote.requests.every((request) => request.project === scope.projectId)).toBe(true);
  });

  it("does not recover a session under another identity when a pending request gets 401", async () => {
    const db = storage();
    const fetcher = vi.fn(async () =>
      Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(pendingSubmissions(db.store).comment(scope, "bug-a", "text")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await pendingSubmissions(db.store).recoverComment(scope, "bug-a")).toBe("text");
  });
});
