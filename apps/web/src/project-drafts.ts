const memory = new Map<string, unknown>();
let connection: Promise<IDBDatabase> | null = null;
function database(): Promise<IDBDatabase> {
  connection ??= new Promise((resolve, reject) => {
    const open = indexedDB.open("qa-hub-preview-project-drafts-v1", 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains("drafts")) open.result.createObjectStore("drafts");
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => {
      connection = null;
      reject(open.error);
    };
  });
  return connection;
}
export async function readProjectDraft<T>(key: string): Promise<T | undefined> {
  if (memory.has(key)) return memory.get(key) as T;
  const db = await database();
  return await new Promise((resolve, reject) => {
    const request = db.transaction("drafts", "readonly").objectStore("drafts").get(key);
    request.onsuccess = () => {
      if (request.result !== undefined) memory.set(key, request.result);
      resolve(request.result as T | undefined);
    };
    request.onerror = () => reject(request.error);
  });
}
export async function writeProjectDraft<T>(key: string, draft: T): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("drafts", "readwrite", { durability: "strict" });
    transaction.objectStore("drafts").put(draft, key);
    transaction.oncomplete = () => {
      memory.set(key, draft);
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** Fresh, serialized read/modify/write. A caller may send a request only after commit. */
export async function updateProjectDraft<T>(
  key: string,
  update: (current: T | undefined) => T,
): Promise<T> {
  const db = await database();
  return await new Promise<T>((resolve, reject) => {
    const transaction = db.transaction("drafts", "readwrite", { durability: "strict" });
    const store = transaction.objectStore("drafts");
    let result: T;
    let failure: unknown;
    const request = store.get(key);
    request.onsuccess = () => {
      try {
        result = update(request.result as T | undefined);
        store.put(result, key);
      } catch (cause) {
        failure = cause;
        transaction.abort();
      }
    };
    transaction.oncomplete = () => {
      memory.set(key, result);
      resolve(result);
    };
    transaction.onerror = transaction.onabort = () => reject(failure ?? transaction.error);
  });
}
