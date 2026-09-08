import { afterEach, expect, it, vi } from "vitest";

// A controlled IndexedDB event boundary: tests decide when a transaction commits
// or aborts. It intentionally does not model browser durability or browser restart.
function databaseBoundary() {
  const disk = new Map<string, unknown>();
  const transactions: {
    oncomplete?: () => void;
    onabort?: () => void;
    onerror?: () => void;
    error?: Error;
    abort: () => void;
    objectStore: () => { get: (key: string) => object; put: (value: unknown, key: string) => void };
    commit: () => void;
  }[] = [];
  const db = {
    transaction: () => {
      const staged = new Map<string, unknown>();
      const transaction = {
        oncomplete: (): void => undefined,
        onabort: (): void => undefined,
        onerror: (): void => undefined,
        error: new Error("transaction aborted"),
        abort: () => {
          queueMicrotask(() => transaction.onabort());
        },
        objectStore: () => ({
          get: (key: string) => {
            const request = { result: disk.get(key), onsuccess: (): void => undefined };
            queueMicrotask(() => request.onsuccess());
            return request;
          },
          put: (value: unknown, key: string) => {
            staged.set(key, structuredClone(value));
          },
        }),
        commit: () => {
          staged.forEach((value, key) => disk.set(key, value));
          transaction.oncomplete();
        },
      };
      transactions.push(transaction);
      return transaction;
    },
  };
  vi.stubGlobal("indexedDB", {
    open: () => {
      const open = { result: db, onsuccess: (): void => undefined };
      queueMicrotask(() => open.onsuccess());
      return open;
    },
  });
  return { disk, transactions };
}
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("an aborted draft write never enters the memory cache", async () => {
  vi.resetModules();
  const boundary = databaseBoundary();
  const { writeProjectDraft, readProjectDraft } = await import("./project-drafts");
  boundary.disk.set("draft", { text: "durable old text" });
  const write = writeProjectDraft("draft", { text: "uncommitted" });
  const failed = expect(write).rejects.toThrow("transaction aborted");
  await flush();
  boundary.transactions[0]?.abort();
  await failed;
  expect(await readProjectDraft("draft")).toEqual({ text: "durable old text" });
  expect(boundary.transactions).toHaveLength(2);
});

it("pending read/modify/write reads fresh disk state and resolves only after commit", async () => {
  vi.resetModules();
  const boundary = databaseBoundary();
  const { writeProjectDraft, readProjectDraft, updateProjectDraft } =
    await import("./project-drafts");
  const cached = writeProjectDraft("journal", { version: 1 });
  await flush();
  boundary.transactions[0]?.commit();
  await cached;
  boundary.disk.set("journal", { version: 2 }); // another window's commit
  let resolved = false;
  const pending = updateProjectDraft<{ version: number }>("journal", (current) => {
    expect(current?.version).toBe(2);
    return { version: 3 };
  }).then((value) => {
    resolved = true;
    return value;
  });
  await flush();
  expect(resolved).toBe(false);
  expect(boundary.disk.get("journal")).toEqual({ version: 2 });
  boundary.transactions[1]?.commit();
  expect(await pending).toEqual({ version: 3 });
  expect(await readProjectDraft("journal")).toEqual({ version: 3 });
});

it("a thrown transaction update leaves the previous durable record intact", async () => {
  vi.resetModules();
  const boundary = databaseBoundary();
  const { updateProjectDraft, readProjectDraft } = await import("./project-drafts");
  boundary.disk.set("journal", { originalId: "retained" });
  await expect(
    updateProjectDraft("journal", () => {
      throw new Error("identity mismatch");
    }),
  ).rejects.toThrow("identity mismatch");
  expect(await readProjectDraft("journal")).toEqual({ originalId: "retained" });
});
