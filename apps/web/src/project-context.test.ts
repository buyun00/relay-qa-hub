import { afterEach, describe, expect, it, vi } from "vitest";
import { loginBrowserSession, requestJson, setBrowserCsrfToken } from "./api";
import { projectStorageKey, setActiveProject, setServiceIdentity } from "./project-context";

afterEach(() => {
  setActiveProject("", "");
  setServiceIdentity("test");
  setBrowserCsrfToken(null);
  vi.unstubAllGlobals();
});
describe("project request and draft isolation", () => {
  it("freezes the project header and rejects a late response after switching", async () => {
    setActiveProject("project-a", "employee");
    let deliver: (response: Response) => void = () => undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(
      () =>
        new Promise<Response>((resolve) => {
          deliver = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const pending = requestJson("/api/v1/bugs?limit=10");
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const init = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get("x-qa-project-id")).toBe("project-a");
    setActiveProject("project-b", "employee");
    expect(init?.signal?.aborted).toBe(true);
    deliver(new Response(JSON.stringify({ items: [{ projectId: "project-a" }] })));
    await rejection;
    expect(new Headers(init?.headers).get("x-qa-project-id")).toBe("project-a");
  });
  it("rejects an A response whose JSON completes after B becomes active", async () => {
    setActiveProject("a", "employee");
    let complete: (body: unknown) => void = () => undefined;
    let jsonStarted = false;
    const response = new Response("{}");
    response.json = () =>
      new Promise((resolve) => {
        jsonStarted = true;
        complete = resolve;
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const pending = requestJson("/api/v1/bugs");
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(jsonStarted).toBe(true));
    setActiveProject("b", "employee");
    complete({ items: [{ projectId: "a" }] });
    await rejection;
  });
  it("uses an explicit project URI for GM edits without changing the active workspace", async () => {
    setActiveProject("a", "gm");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    await requestJson("/api/v1/projects/b/components/build", { method: "PUT", body: "{}" });
    expect(
      new Headers((fetch.mock.calls[0]?.[1] as RequestInit | undefined)?.headers).get(
        "x-qa-project-id",
      ),
    ).toBe("b");
    await requestJson("/api/v1/bugs");
    expect(
      new Headers((fetch.mock.calls[1]?.[1] as RequestInit | undefined)?.headers).get(
        "x-qa-project-id",
      ),
    ).toBe("a");
  });
  it("binds login to its explicit project and keeps local keys distinct across service, project and employee", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            accountId: "account",
            userId: "user",
            displayName: "Employee",
            email: "employee@test",
            csrfToken: "test-csrf",
            projectId: "a",
          }),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    setActiveProject("a", "user");
    await loginBrowserSession("Employee", "Project A", "0042");
    expect(JSON.parse(String((fetch.mock.calls[0]?.[1] as RequestInit | undefined)?.body))).toEqual(
      { name: "Employee", projectName: "Project A", code: "0042", client: "web" },
    );
    const a = projectStorageKey("upload-draft");
    setActiveProject("b", "user");
    const b = projectStorageKey("upload-draft");
    setActiveProject("a", "another");
    const user = projectStorageKey("upload-draft");
    setActiveProject("a", "user");
    setServiceIdentity("http://another-preview:4274");
    const service = projectStorageKey("upload-draft");
    expect(new Set([a, b, user, service]).size).toBe(4);
  });
});
