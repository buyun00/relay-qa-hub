import { projectStorageKey } from "./project-context";
import type { UploaderBridge, UploadReply } from "@relay-qa-hub/upload-contract";
import { requestJson, QaHubApiError } from "./api";

const base = "/api/v1/increment-upload";
const pending = new Map<string, { key: string; fingerprint: string }>();
export function createUploadRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // getRandomValues is also available on the existing private-LAN HTTP site.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 15) | 64;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
// Keep an uncertain submission's key across retries and page reloads. Actor namespacing
// prevents one signed-in user from reusing another user's submission key.
function requestKey(action: string, value: unknown): { key: string; clear: () => void } {
  const storage = projectStorageKey(`server-upload-request:${action}`);
  const fingerprint = JSON.stringify(value);
  const previous = pending.get(storage);
  let key = previous?.fingerprint === fingerprint ? previous.key : createUploadRequestId();
  try {
    const prior = JSON.parse(localStorage.getItem(storage) ?? "null");
    if (prior?.fingerprint === fingerprint && typeof prior.key === "string") key = prior.key;
    localStorage.setItem(storage, JSON.stringify({ key, fingerprint }));
  } catch {
    /* The in-memory pending submission still retains this key. */
  }
  pending.set(storage, { key, fingerprint });
  return {
    key,
    clear: () => {
      pending.delete(storage);
      try {
        localStorage.removeItem(storage);
      } catch {
        /* Storage can be denied. */
      }
    },
  };
}
async function call<T>(route: string, body?: unknown, idempotent = false): Promise<UploadReply<T>> {
  const submission = idempotent ? requestKey(route, body) : null;
  try {
    const value = await requestJson(
      base + route,
      body === undefined
        ? undefined
        : {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(submission ? { "idempotency-key": submission.key } : {}),
            },
            body: JSON.stringify(body),
          },
    );
    submission?.clear();
    return { ok: true, value: value as T };
  } catch (error) {
    const code = error instanceof QaHubApiError ? error.code : "UPLOAD_SERVICE_UNAVAILABLE";
    return { ok: false, code: code ?? "UPLOAD_SERVICE_UNAVAILABLE" };
  }
}
export const serverUploader: UploaderBridge = {
  snapshot: () => call(""),
  login: (input) => call("/login", input),
  logout: () => call("/logout", {}),
  checkAuth: () => call("/check-auth", {}),
  start: (input) => call("/jobs", input, true),
  resume: (input) => call(`/jobs/${encodeURIComponent(input.id)}/resume`, input, true),
  confirmPublish: (id) => call(`/jobs/${encodeURIComponent(id)}/confirm-publish`, {}, true),
  cancel: (id) => call(`/jobs/${encodeURIComponent(id)}/cancel`, {}),
  buildChains: () => call("/build-chains"),
  buildAndUpload: (input) => call("/build-chains", { upload: input.upload }, true),
  cancelBuildUpload: (id) => call(`/build-chains/${encodeURIComponent(id)}/cancel`, {}),
  openFolder: async (id) => {
    const result = await call<unknown>(`/jobs/${encodeURIComponent(id)}/logs`);
    if (!result.ok) return result;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(result.value, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `increment-upload-${id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ok: true, value: true };
  },
};
