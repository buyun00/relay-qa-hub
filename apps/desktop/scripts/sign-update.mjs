import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const RELEASE_ID_PATTERN = /^\d{8}T\d{9}Z$/u;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u;

function argumentsMap(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (typeof key !== "string" || !key.startsWith("--") || typeof value !== "string") {
      throw new Error("Arguments must use --name value pairs.");
    }
    result.set(key.slice(2), value);
  }
  return result;
}

function required(args, name) {
  const value = args.get(name)?.trim();
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}

const args = argumentsMap(process.argv.slice(2));
const archiveFile = path.resolve(required(args, "archive"));
const manifestFile = path.resolve(required(args, "manifest"));
const releaseId = required(args, "release-id");
const version = required(args, "version");
const archiveUrl = required(args, "url");
if (!RELEASE_ID_PATTERN.test(releaseId)) throw new Error("Invalid release ID.");
if (!VERSION_PATTERN.test(version)) throw new Error("Invalid release version.");
if (!archiveUrl.startsWith("/") || archiveUrl.startsWith("//") || archiveUrl.length > 2_048) {
  throw new Error("The update archive URL must be a bounded same-origin path.");
}

const defaultKeyFile = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "Relay QA Hub Publisher",
  "update-signing-private.pem",
);
const privateKeyFile = path.resolve(
  process.env.QA_HUB_UPDATE_SIGNING_KEY?.trim() || defaultKeyFile,
);
const [archive, archiveStat, privateKeyPem] = await Promise.all([
  readFile(archiveFile),
  stat(archiveFile),
  readFile(privateKeyFile, "utf8"),
]);
if (!archiveStat.isFile() || archiveStat.size <= 0) throw new Error("Update archive is empty.");

const payload = {
  schemaVersion: 1,
  releaseId,
  version,
  publishedAt: new Date().toISOString(),
  archive: {
    url: archiveUrl,
    size: archiveStat.size,
    sha256: createHash("sha256").update(archive).digest("hex"),
  },
};
const signature = sign(
  null,
  Buffer.from(JSON.stringify(payload), "utf8"),
  createPrivateKey(privateKeyPem),
).toString("base64");
await writeFile(manifestFile, `${JSON.stringify({ ...payload, signature }, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o644,
});
process.stdout.write(
  `${JSON.stringify({ manifestFile, releaseId, archiveSize: archiveStat.size })}\n`,
);
