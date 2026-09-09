import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import dns from "node:dns";
import dgram from "node:dgram";
import cp from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isMainThread } from "node:worker_threads";

const role = process.env.QA_PHASE_A_ROLE;
if (!["api", "mcp", "selftest"].includes(role)) throw new Error("PHASE_A_GUARD_ROLE_REQUIRED");
const deny = (kind) => {
  appendFileSync(
    process.env.QA_PHASE_A_GUARD_LOG,
    JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      mainThread: isMainThread,
      kind,
    }) + "\n",
  );
  throw Object.assign(new Error(`PHASE_A_GUARD_DENIED:${kind}`), { code: "PHASE_A_GUARD_DENIED" });
};
function endpoint(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (typeof first === "object" && first !== null)
    return { host: first.hostname ?? first.host, port: Number(first.port), path: first.path };
  return { port: Number(first), host: args[1] };
}
function allowed(host, port) {
  return role === "mcp" && host === "127.0.0.1" && Number(port) === 4459;
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const x = endpoint(args);
  if (!allowed(x.host, x.port) || x.path) deny("socket");
  return Reflect.apply(connect, this, args);
};
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const x = endpoint(args);
  if (x.host !== "127.0.0.1" || x.port !== (role === "mcp" ? 4461 : 4459) || x.path) deny("listen");
  return Reflect.apply(listen, this, args);
};
for (const [module, scheme] of [
  [http, "http:"],
  [https, "https:"],
]) {
  for (const method of ["request", "get"]) {
    const original = module[method];
    module[method] = function (...args) {
      const a = args[0];
      const x = typeof a === "string" || a instanceof URL ? new URL(a) : a;
      if (scheme !== "http:" || !allowed(x.hostname ?? x.host, x.port ?? 80))
        deny(`${scheme}${method}`);
      return Reflect.apply(original, this, args);
    };
  }
}
const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const u = new URL(input instanceof Request ? input.url : input);
  if (u.protocol !== "http:" || !allowed(u.hostname, u.port || 80)) deny("fetch");
  return originalFetch(input, init);
};
tls.connect = () => deny("tls");
dgram.createSocket = () => deny("dgram");
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
  cp[name] = () => deny(`child:${name}`);
for (const name of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"]) {
  const original = dns[name];
  dns[name] = function (...args) {
    if (name === "lookup" && args[0] === "127.0.0.1") return Reflect.apply(original, this, args);
    return deny(`dns:${name}`);
  };
  if (dns.promises[name]) {
    const promiseOriginal = dns.promises[name];
    dns.promises[name] = function (...args) {
      if (name === "lookup" && args[0] === "127.0.0.1")
        return Reflect.apply(promiseOriginal, this, args);
      return deny(`dns.promises:${name}`);
    };
  }
}
syncBuiltinESMExports();
if (isMainThread && process.send)
  process.on("message", (message) => {
    if (message?.command === "phase-a-official-sigterm") {
      process.emit("SIGTERM");
      process.disconnect();
    }
  });
