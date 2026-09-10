import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

import ts from "typescript";

import { parseDesktopBugRoute } from "../src/bug-route.cjs";

const PROJECT_ID = "40000000-0000-4000-8000-000000000001";
const USER_ID = "50000000-0000-4000-8000-000000000001";
const BUG_ID = "30000000-0000-4000-8000-000000000001";

type IpcHandler = (...args: unknown[]) => void;

interface SandboxBridge {
  readonly onOpenBug: (listener: (route: unknown) => void) => () => void;
}

async function loadSandboxedPreload(): Promise<{
  bridge: SandboxBridge;
  ipcHandlers: ReadonlyMap<string, IpcHandler>;
}> {
  const source = await readFile(new URL("../src/preload.cts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2023,
      verbatimModuleSyntax: true,
    },
    fileName: "preload.cts",
  }).outputText;
  const compiledRequires = [...compiled.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/gu)].map(
    (match) => match[1],
  );
  assert.deepEqual(compiledRequires, ["electron"]);
  const ipcHandlers = new Map<string, IpcHandler>();
  const requiredModules: string[] = [];
  let exposedName: string | undefined;
  let exposedBridge: unknown;
  const ipcRenderer = {
    invoke: async () => undefined,
    on: (channel: string, handler: IpcHandler) => {
      ipcHandlers.set(channel, handler);
      return ipcRenderer;
    },
    removeListener: () => ipcRenderer,
  };
  const cjsExports = {};

  runInNewContext(
    compiled,
    {
      URL,
      exports: cjsExports,
      module: { exports: cjsExports },
      queueMicrotask,
      require: (specifier: string) => {
        requiredModules.push(specifier);
        if (specifier === "electron") {
          return {
            contextBridge: {
              exposeInMainWorld: (name: string, value: unknown) => {
                exposedName = name;
                exposedBridge = value;
              },
            },
            ipcRenderer,
          };
        }
        throw new Error(`sandbox preload cannot require ${specifier}`);
      },
    },
    { filename: "preload.cjs" },
  );

  assert.deepEqual(requiredModules, ["electron"]);
  assert.equal(exposedName, "qaHubDesktop");
  assert.equal(typeof exposedBridge, "object");
  assert.notEqual(exposedBridge, null);
  return {
    bridge: exposedBridge as SandboxBridge,
    ipcHandlers,
  };
}

test("desktop Bug routes preserve and normalize their project and user scope", () => {
  assert.deepEqual(
    parseDesktopBugRoute({
      projectId: PROJECT_ID.toUpperCase(),
      userId: USER_ID.toUpperCase(),
      bugId: BUG_ID.toUpperCase(),
    }),
    { projectId: PROJECT_ID, userId: USER_ID, bugId: BUG_ID },
  );
});

test("legacy deep links retain an explicitly null project and user scope", () => {
  assert.deepEqual(parseDesktopBugRoute({ projectId: null, userId: null, bugId: BUG_ID }), {
    projectId: null,
    userId: null,
    bugId: BUG_ID,
  });
});

test("desktop Bug routes reject missing, mismatched, invalid, or extra scope data", () => {
  for (const value of [
    { projectId: PROJECT_ID, userId: USER_ID },
    { projectId: PROJECT_ID, userId: null, bugId: BUG_ID },
    { projectId: null, userId: USER_ID, bugId: BUG_ID },
    { projectId: "not-a-uuid", userId: USER_ID, bugId: BUG_ID },
    { projectId: PROJECT_ID, userId: USER_ID, bugId: "not-a-uuid" },
    { projectId: PROJECT_ID, userId: USER_ID, bugId: BUG_ID, extra: true },
  ]) {
    assert.equal(parseDesktopBugRoute(value), null);
  }
});

test("sandboxed preload exposes its bridge without local require and matches main route parsing", async () => {
  const { bridge, ipcHandlers } = await loadSandboxedPreload();
  const openBugHandler = ipcHandlers.get("desktop:open-bug");
  assert.ok(openBugHandler);
  const observed: unknown[] = [];
  bridge.onOpenBug((route) => observed.push(route));

  for (const value of [
    {
      projectId: PROJECT_ID.toUpperCase(),
      userId: USER_ID.toUpperCase(),
      bugId: BUG_ID.toUpperCase(),
    },
    { projectId: null, userId: null, bugId: BUG_ID },
    { projectId: PROJECT_ID, userId: USER_ID },
    { projectId: PROJECT_ID, userId: null, bugId: BUG_ID },
    { projectId: null, userId: USER_ID, bugId: BUG_ID },
    { projectId: "not-a-uuid", userId: USER_ID, bugId: BUG_ID },
    { projectId: PROJECT_ID, userId: USER_ID, bugId: "not-a-uuid" },
    { projectId: PROJECT_ID, userId: USER_ID, bugId: BUG_ID, extra: true },
    null,
  ]) {
    const expected = parseDesktopBugRoute(value);
    const countBefore = observed.length;
    openBugHandler({}, value);
    if (expected === null) {
      assert.equal(observed.length, countBefore);
    } else {
      assert.equal(observed.length, countBefore + 1);
      assert.deepEqual(JSON.parse(JSON.stringify(observed.at(-1))) as unknown, expected);
    }
  }
});
