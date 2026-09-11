import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function readVersion(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label}_INVALID`);
  }
  if (!Number.isSafeInteger(value?.versionCode) || value.versionCode < 1) {
    throw new Error(`${label}_INVALID`);
  }
  return value.versionCode;
}

function writeExactCreateOnly(file, bytes, code) {
  if (existsSync(file)) {
    if (!readFileSync(file).equals(bytes)) throw new Error(code);
    return;
  }
  writeFileSync(file, bytes, { flag: "wx", flush: true });
}

export function publishVersionedJson({ target, bytes, versionCode }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error("VERSIONED_JSON_INVALID");
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) {
    throw new Error("VERSIONED_JSON_INVALID");
  }
  if (readVersion(bytes, "VERSIONED_JSON") !== versionCode) {
    throw new Error("VERSIONED_JSON_VERSION_MISMATCH");
  }

  const digest = sha256(bytes);
  const previous = existsSync(target) ? readFileSync(target) : null;
  if (previous?.equals(bytes)) return { published: false, replayed: true, history: null };

  let history = null;
  if (previous) {
    const previousVersion = readVersion(previous, "VERSIONED_JSON_PREDECESSOR");
    if (previousVersion >= versionCode) throw new Error("VERSIONED_JSON_NOT_NEWER");
    history = join(
      dirname(target),
      `${basename(target)}.history-v${previousVersion}-${sha256(previous).slice(0, 16)}.json`,
    );
    writeExactCreateOnly(history, previous, "VERSIONED_JSON_HISTORY_CONFLICT");
  }

  const candidate = `${target}.next-v${versionCode}-${digest.slice(0, 16)}`;
  writeExactCreateOnly(candidate, bytes, "VERSIONED_JSON_CANDIDATE_CONFLICT");

  const current = existsSync(target) ? readFileSync(target) : null;
  if ((previous === null) !== (current === null) || (previous && !current.equals(previous))) {
    throw new Error("VERSIONED_JSON_PREDECESSOR_CHANGED");
  }
  try {
    renameSync(candidate, target);
  } catch (error) {
    if (!existsSync(target) || !readFileSync(target).equals(bytes)) throw error;
  }
  if (!readFileSync(target).equals(bytes)) throw new Error("VERSIONED_JSON_COMMIT_MISMATCH");
  return { published: true, replayed: false, history };
}
