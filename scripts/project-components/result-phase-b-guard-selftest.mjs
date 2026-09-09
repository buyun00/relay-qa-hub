import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import dns from "node:dns";
import dgram from "node:dgram";
import cp from "node:child_process";
import { Worker, isMainThread, parentPort } from "node:worker_threads";
const tests = [
  ["fetch", () => fetch("https://fixture.invalid")],
  ["http", () => http.request("http://fixture.invalid")],
  ["https", () => https.request("https://fixture.invalid")],
  ["socket", () => net.connect(4319, "127.0.0.1")],
  ["listen", () => net.createServer().listen(4319, "127.0.0.1")],
  ["tls", () => tls.connect(443, "fixture.invalid")],
  ["dns", () => dns.lookup("fixture.invalid", () => {})],
  ["dgram", () => dgram.createSocket("udp4")],
  ["spawn", () => cp.spawn("definitely-not-run")],
  ["exec", () => cp.exec("definitely-not-run")],
];
const results = [];
for (const [name, action] of tests) {
  assert.throws(action, { code: "PHASE_B_GUARD_DENIED" });
  results.push({ name, denied: true });
}
if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url));
  const inherited = await new Promise((accept, reject) => {
    worker.on("message", accept);
    worker.on("error", reject);
  });
  await new Promise((accept, reject) => {
    worker.on("exit", (code) =>
      code === 0 ? accept() : reject(new Error("worker selftest exit")),
    );
  });
  console.log(
    JSON.stringify({
      status: "passed",
      main: results,
      worker: inherited,
      boundary: "Guard denial proof only; not application E2E",
    }),
  );
} else parentPort.postMessage(results);
