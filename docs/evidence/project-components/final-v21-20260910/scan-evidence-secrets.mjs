import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
const instancePath =
  "C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-v21-e2e-fresh-0910/instance.json";
const instance = JSON.parse(await readFile(instancePath, "utf8"));
const secrets = JSON.parse(await readFile(instance.secretsFile, "utf8"));
const protectedValues = Object.entries(secrets)
  .filter(([, value]) => typeof value === "string" && value.length > 0)
  .map(([name, value]) => ({ name, bytes: Buffer.from(value, "utf8") }));
const textExtensions = new Set([".json", ".md", ".txt", ".mjs", ".log", ".xml"]);
const credentialPatterns = [
  ["authorization-bearer", /authorization\s*[:=]\s*["']?bearer\s+[a-z0-9._~-]{8,}/iu],
  ["access-token-json", /["']accessToken["']\s*:\s*["'][^"']+["']/iu],
  ["refresh-token-json", /["']refreshToken["']\s*:\s*["'][^"']+["']/iu],
  ["gm-password-json", /["']gmPassword["']\s*:\s*["'][^"']+["']/iu],
  ["debug-token-json", /["']debugToken["']\s*:\s*["'][^"']+["']/iu],
  ["set-cookie-value", /set-cookie\s*:\s*[^\r\n]+/iu],
];

async function visit(directory) {
  const items = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const item of items) {
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) files.push(...(await visit(absolute)));
    else if (item.isFile()) files.push(absolute);
  }
  return files;
}

const outputPath = path.join(root, "secret-scan.json");
const scriptPath = fileURLToPath(import.meta.url);
const files = (await visit(root)).filter(
  (file) => file !== outputPath && file !== scriptPath && path.basename(file) !== "evidence-index.json",
);
const exactSecretHits = [];
const patternHits = [];
for (const file of files) {
  const bytes = await readFile(file);
  const relative = path.relative(root, file).split(path.sep).join("/");
  for (const secret of protectedValues) {
    if (bytes.indexOf(secret.bytes) >= 0) exactSecretHits.push({ path: relative, secretName: secret.name });
  }
  if (textExtensions.has(path.extname(file).toLowerCase())) {
    const text = bytes.toString("utf8");
    for (const [label, pattern] of credentialPatterns) {
      if (pattern.test(text)) patternHits.push({ path: relative, pattern: label });
    }
  }
}
assert.deepEqual(exactSecretHits, []);
assert.deepEqual(patternHits, []);
const result = {
  schemaVersion: 1,
  scannedAt: new Date().toISOString(),
  sourceCommit: "88a6d0f9c31106f6cd3fc9edbadca0db6bf6397b",
  scannedFileCount: files.length,
  protectedValueCount: protectedValues.length,
  exactSecretHits,
  credentialPatternHits: patternHits,
  excludedFromScan: ["evidence-index.json", "secret-scan.json", "scan-evidence-secrets.mjs"],
  credentialsPersisted: false,
  passed: true,
};
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
