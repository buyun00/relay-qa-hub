import { afterEach, expect, it, vi } from "vitest";
import { requestJson } from "./api";
import { createUploadRequestId, serverUploader } from "./increment-upload-api";
import { uploadDraftDefaults } from "./upload-model";

vi.mock("./api", () => ({
  requestJson: vi.fn(),
  QaHubApiError: class extends Error {
    code = "fixture";
  },
}));
const request = vi.mocked(requestJson);
afterEach(() => {
  vi.unstubAllGlobals();
  request.mockReset();
});
function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  return values;
}
it("lost responses reuse the persisted server submission ID", async () => {
  const values = storage(),
    input = uploadDraftDefaults(null);
  request
    .mockRejectedValueOnce(new Error("lost acknowledgement"))
    .mockResolvedValueOnce("existing-job");
  expect((await serverUploader.start(input)).ok).toBe(false);
  expect(values.size).toBe(1);
  expect(await serverUploader.start(input)).toEqual({ ok: true, value: "existing-job" });
  expect(request.mock.calls[0]?.[1]?.headers).toEqual(request.mock.calls[1]?.[1]?.headers);
  expect(values.size).toBe(0);
  expect(request.mock.calls[0]?.[0]).toBe("/api/v1/increment-upload/jobs");
});
it("disabled browser storage retains the in-memory retry key", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  });
  const input = uploadDraftDefaults({ version: "fixture-disabled-storage" });
  request.mockRejectedValueOnce(new Error("lost")).mockResolvedValueOnce("existing-job");
  await serverUploader.start(input);
  await serverUploader.start(input);
  expect(request.mock.calls[0]?.[1]?.headers).toEqual(request.mock.calls[1]?.[1]?.headers);
});
it("private LAN HTTP can generate valid request IDs without randomUUID", () => {
  const original = crypto.getRandomValues.bind(crypto);
  vi.stubGlobal("crypto", { getRandomValues: original });
  const first = createUploadRequestId(),
    second = createUploadRequestId();
  expect(first).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  expect(first).not.toBe(second);
});
it("account credentials are sent only to the server login route and never saved as retry data", async () => {
  const values = storage();
  request.mockResolvedValue(true);
  await serverUploader.login({ account: "fixture", password: "fixture-secret", kind: "email" });
  expect(request.mock.calls[0]?.[0]).toBe("/api/v1/increment-upload/login");
  expect(values.size).toBe(0);
});
