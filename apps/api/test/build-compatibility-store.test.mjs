import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeCompatibilityState } from "../dist/build-compatibility-store.js";

test("a transient Windows file lock retries the same atomic snapshot without losing the previous result", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "check-store-"));
  const file = path.join(root, "current.json");
  await fs.writeFile(file, JSON.stringify({ id: "previous" }));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rename = fs.rename;
  let calls = 0;
  const temporaries = [];
  t.mock.method(fs, "rename", async (from, to) => {
    calls++;
    temporaries.push(from);
    if (calls < 3) {
      assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { id: "previous" });
      throw Object.assign(Error("Sharing violation"), { code: calls === 1 ? "EPERM" : "EACCES" });
    }
    return rename(from, to);
  });
  await writeCompatibilityState(file, { id: "next" });
  assert.equal(calls, 3);
  assert.equal(new Set(temporaries).size, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { id: "next" });
  assert.deepEqual(await fs.readdir(root), ["current.json"]);
});

test("a permanent storage error keeps the previous file and does not hide the failure", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "check-store-"));
  const file = path.join(root, "current.json");
  await fs.writeFile(file, JSON.stringify({ id: "previous" }));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let calls = 0;
  t.mock.method(fs, "rename", async () => {
    calls++;
    throw Object.assign(Error("Disk full"), { code: "ENOSPC" });
  });
  await assert.rejects(writeCompatibilityState(file, { id: "next" }), { code: "ENOSPC" });
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { id: "previous" });
  assert.deepEqual(await fs.readdir(root), ["current.json"]);
});

test(
  "real Windows sharing lock clears without losing or duplicating a saved batch",
  { skip: process.platform !== "win32" },
  async (t) => {
    const { spawn } = await import("node:child_process");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "check-store-lock-"));
    const file = path.join(root, "current.json"),
      ready = path.join(root, "ready"),
      script = path.join(root, "hold.ps1");
    await fs.writeFile(file, JSON.stringify({ id: "previous" }));
    await fs.writeFile(
      script,
      `param([string]$TargetPath,[string]$SignalPath)
$ErrorActionPreference='Stop'
$handle=[IO.File]::Open($TargetPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
try { [IO.File]::WriteAllText($SignalPath,'ready'); Start-Sleep -Milliseconds 650 } finally { $handle.Dispose() }
`,
    );
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-TargetPath",
        file,
        "-SignalPath",
        ready,
      ],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let diagnostic = "";
    child.stderr.on("data", (chunk) => {
      diagnostic += chunk.toString();
    });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    t.after(async () => {
      await exited;
      await fs.rm(root, { recursive: true, force: true });
    });
    const deadline = Date.now() + 10000;
    while (true) {
      try {
        await fs.access(ready);
        break;
      } catch {
        if (child.exitCode !== null || Date.now() > deadline)
          throw Error("Lock helper did not start: " + diagnostic);
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    const started = Date.now();
    await writeCompatibilityState(file, { id: "next" });
    assert.ok(Date.now() - started >= 500, "The save should wait for the real sharing lock");
    assert.equal(await exited, 0);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { id: "next" });
    assert.ok(!(await fs.readdir(root)).some((f) => f.endsWith(".tmp")));
  },
);
