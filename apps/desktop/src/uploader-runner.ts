// This small supervisor outlives the window and writes a receipt even if the UI exits.
// Its arguments contain only application-owned paths and a random run ID.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { UPLOADER_SHA256, writeJson } from "./uploader-host.js";

const [executable, directory, runId, command] = process.argv.slice(2);
if (
  !executable ||
  !directory ||
  !runId ||
  !/^[a-f0-9-]{36}$/.test(runId) ||
  !["run", "resume", "confirm-publish"].includes(command ?? "")
)
  process.exit(2);
const receipt = path.join(directory, `run-${runId}.json`);
try {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(executable)) hash.update(chunk as Buffer);
  if (hash.digest("hex") !== UPLOADER_SHA256) throw new Error("UPLOADER_INTEGRITY_FAILED");
  const runningReceipt = {
    pid: process.pid,
    finished: false,
    startedAt: new Date().toISOString(),
  };
  await writeJson(receipt, { ...runningReceipt, updatedAt: new Date().toISOString() });
  const output = await fs.open(path.join(directory, `run-${runId}.jsonl`), "a");
  try {
    const env = { ...process.env };
    delete env["OZDQP_AUTHORIZATION"];
    const child = spawn(executable, [command!, "--config", path.join(directory, "job.json")], {
      windowsHide: true,
      stdio: ["ignore", output.fd, output.fd],
      env,
    });
    let heartbeat = Promise.resolve();
    const timer = setInterval(() => {
      heartbeat = heartbeat
        .then(() => writeJson(receipt, { ...runningReceipt, updatedAt: new Date().toISOString() }))
        .catch(() => {});
    }, 5000);
    let code: number | null;
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearInterval(timer);
      await heartbeat;
    }
    await writeJson(receipt, {
      pid: process.pid,
      finished: true,
      exitCode: code,
      finishedAt: new Date().toISOString(),
    });
  } finally {
    await output.close();
  }
} catch {
  await writeJson(receipt, {
    pid: process.pid,
    finished: true,
    errorCode: "UPLOADER_START_FAILED",
    finishedAt: new Date().toISOString(),
  });
  process.exitCode = 1;
}
