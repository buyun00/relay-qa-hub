import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const productSourceCommit = "fd0f0f850f907b8a77aac8ec8b6a71b308bdd711";
const defaultInstancePath =
  "C:/Users/lin0/.codex/parallel-runtimes/qa-hub-preview-v21-e2e-fresh-0910/instance.json";
const expectedInstanceSha256 = "cf92bad26060bbcddcfc37d620320e8bac15e09104088944e456a3b9205257db";
const expectedSecretsSha256 = "fcf0173d2eaac6c6a7d6fa56a990870796a80fac34bee3de696a7fdd094c4468";
const expectedSecretNames = ["debugToken", "gmPassword", "sessionSecret"];
const defaultSecretsPath = path.join(path.dirname(defaultInstancePath), "secrets.json");
const outputName = "secret-scan.json";
const excludedPaths = [
  "evidence-index.json",
  "final-validation.json",
  outputName,
  "scan-evidence-secrets.mjs",
];

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  assert.ok(value && !value.startsWith("--"), `${name} requires a value`);
  return value;
}

const dryRun = process.argv.includes("--dry-run");
const root = path.resolve(
  option("--root") ?? fileURLToPath(new URL("./", import.meta.url)),
);
const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const rootFromRepo = path.relative(repoRoot, root);
assert.ok(
  rootFromRepo &&
    rootFromRepo !== ".." &&
    !rootFromRepo.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rootFromRepo),
  "evidence root must be inside the repository",
);

function repoContainedPath(relative, label) {
  assert.equal(typeof relative, "string", `${label}: path must be a string`);
  assert.ok(relative.length > 0 && !path.isAbsolute(relative), `${label}: relative path required`);
  assert.ok(!relative.includes("\\"), `${label}: forward-slash path required`);
  const absolute = path.resolve(root, ...relative.split("/"));
  const fromRepo = path.relative(repoRoot, absolute);
  assert.ok(
    fromRepo &&
      fromRepo !== ".." &&
      !fromRepo.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(fromRepo),
    `${label}: path escaped the repository`,
  );
  return absolute;
}

async function repoRegularFile(relative, label) {
  const absolute = repoContainedPath(relative, label);
  const fromRepo = path.relative(repoRoot, absolute);
  let cursor = repoRoot;
  let stat;
  for (const part of fromRepo.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    stat = await lstat(cursor);
    assert.equal(stat.isSymbolicLink(), false, `${label}: path contains a symbolic link`);
  }
  assert.equal(stat?.isFile(), true, `${label}: evidence must be a regular file`);
  return absolute;
}

async function absoluteRegularFile(absoluteInput, label) {
  const absolute = path.resolve(absoluteInput);
  const volumeRoot = path.parse(absolute).root;
  let cursor = volumeRoot;
  let stat;
  for (const part of path.relative(volumeRoot, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    stat = await lstat(cursor);
    assert.equal(stat.isSymbolicLink(), false, `${label}: path contains a symbolic link`);
  }
  assert.equal(stat?.isFile(), true, `${label}: path must be a regular file`);
  return absolute;
}

const instancePath = path.resolve(
  option("--instance-path") ?? process.env.QA_HUB_PREVIEW_INSTANCE_PATH ?? defaultInstancePath,
);
assert.equal(
  path.win32.normalize(instancePath).toLowerCase(),
  path.win32.normalize(defaultInstancePath).toLowerCase(),
  "secret scan must use the canonical isolated instance",
);
const verifiedInstancePath = await absoluteRegularFile(instancePath, "instance file");
const instanceBytes = await readFile(verifiedInstancePath);
assert.equal(createHash("sha256").update(instanceBytes).digest("hex"), expectedInstanceSha256);
const instance = JSON.parse(instanceBytes.toString("utf8").replace(/^\uFEFF/u, ""));
assert.equal(instance.instanceId, "qa-hub-preview-v21-e2e-fresh-0910");
assert.equal(typeof instance.secretsFile, "string", "instance.secretsFile is required");
const secretsPath = path.resolve(instance.secretsFile);
assert.equal(
  path.win32.normalize(secretsPath).toLowerCase(),
  path.win32.normalize(defaultSecretsPath).toLowerCase(),
  "instance.secretsFile must be the canonical isolated secrets file",
);
const verifiedSecretsPath = await absoluteRegularFile(secretsPath, "secrets file");
const secretsBytes = await readFile(verifiedSecretsPath);
assert.equal(createHash("sha256").update(secretsBytes).digest("hex"), expectedSecretsSha256);
const secrets = JSON.parse(secretsBytes.toString("utf8").replace(/^\uFEFF/u, ""));
assert.deepEqual(Object.keys(secrets).sort(), expectedSecretNames);
assert.ok(expectedSecretNames.every((name) => typeof secrets[name] === "string" && secrets[name]));
const protectedValues = Object.entries(secrets)
  .filter(([, value]) => typeof value === "string" && value.length > 0)
  .map(([name, value]) => ({ name, bytes: Buffer.from(value, "utf8") }));
const textExtensions = new Set([".json", ".md", ".txt", ".mjs", ".ps1", ".log", ".xml"]);
const credentialPatterns = [
  [
    "authorization-bearer",
    /["']?authorization["']?\s*[:=]\s*["']?bearer\s+[a-z0-9._~+/-]{8,}=*/iu,
  ],
  [
    "access-token-json",
    /["']accessToken["']\s*:\s*["'](?!(?:\[?redacted\]?|<redacted>|\*+)["'])[^"']+["']/iu,
  ],
  [
    "refresh-token-json",
    /["']refreshToken["']\s*:\s*["'](?!(?:\[?redacted\]?|<redacted>|\*+)["'])[^"']+["']/iu,
  ],
  [
    "gm-password-json",
    /["']gmPassword["']\s*:\s*["'](?!(?:\[?redacted\]?|<redacted>|\*+)["'])[^"']+["']/iu,
  ],
  [
    "debug-token-json",
    /["']debugToken["']\s*:\s*["'](?!(?:\[?redacted\]?|<redacted>|\*+)["'])[^"']+["']/iu,
  ],
  [
    "set-cookie-value",
    /["']?set-cookie["']?\s*:\s*["']?(?!(?:\[?redacted\]?|<redacted>|\*+)["']?(?:\s*[,}]|\s*$))[^"'\r\n]+/imu,
  ],
];

async function visit(directory) {
  const items = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const item of items.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const absolute = path.join(directory, item.name);
    const stat = await lstat(absolute);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    assert.equal(stat.isSymbolicLink(), false, `evidence link is not allowed: ${relative}`);
    if (stat.isDirectory()) files.push(...(await visit(absolute)));
    else if (stat.isFile() && !excludedPaths.includes(relative)) files.push(absolute);
  }
  return files;
}

const rootFiles = await visit(root);
const acceptancePath = await repoRegularFile("acceptance-matrix.json", "acceptance matrix");
const acceptance = JSON.parse(
  (await readFile(acceptancePath, "utf8")).replace(/^\uFEFF/u, ""),
);
function collectDeclaredEvidence(value, propertyName = null) {
  if (propertyName === "evidence") {
    assert.ok(Array.isArray(value), "declared evidence must be an array");
    assert.ok(value.every((item) => typeof item === "string"), "declared evidence must be paths");
    return value;
  }
  if (Array.isArray(value)) return value.flatMap((item) => collectDeclaredEvidence(item));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([name, item]) => collectDeclaredEvidence(item, name));
}
function collectSemanticProofDependencies(value, propertyName = null) {
  if (propertyName === "semanticProof") {
    assert.equal(typeof value, "string", "semanticProof must be a path");
    assert.match(
      value,
      /^\.\.\/desktop-notification-project-route-live\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/proof\.json$/u,
      "semanticProof must use the canonical notification runner path",
    );
    const proofRoot = path.posix.dirname(value);
    const blockedProof =
      value ===
      "../desktop-notification-project-route-live/81c44b26-5c6f-47c6-a56a-d4eb27f19d7a/proof.json";
    const rawNames = blockedProof
      ? [
          "host-before.json",
          "host-after.json",
          "session-preflight-native-submit.json",
          "session-preflight-native-close.json",
          "session-preflight-toast-ready.json",
          "session-preflight-wpn-boundary.json",
          "session-preflight-wpn-events.json",
          "session-preflight-wpn-query-002.json",
          "session-preflight-wpn-correlation.json",
        ]
      : [
          "a1-toast-observed.json",
          "a1-toast-invoked.json",
          "a1-routed-renderer.json",
          "a2-toast-observed.json",
          "a2-toast-invoked.json",
          "a2-denied-renderer.json",
          "b3-toast-observed.json",
          "host-before.json",
          "host-after-quit-probe.json",
          "host-after.json",
        ];
    return [
      value,
      ...rawNames.map((name) => `${proofRoot}/raw/${name}`),
    ];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectSemanticProofDependencies(item));
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([name, item]) =>
    collectSemanticProofDependencies(item, name),
  );
}
const declaredEvidence = [
  ...new Set([
    ...collectDeclaredEvidence(acceptance),
    ...collectSemanticProofDependencies(acceptance),
  ]),
];
const referencedEvidence = (
  await Promise.all(
    declaredEvidence.map(async (relative) => ({
      absolute: await repoRegularFile(relative, `declared evidence ${relative}`),
      relative,
    })),
  )
)
  .filter(({ absolute }) => {
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    return relative.startsWith("../");
  })
  .map(({ absolute }) => absolute);
const files = [...new Set([...rootFiles, ...referencedEvidence])].sort((a, b) =>
  a.localeCompare(b, "en"),
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
    const contents = bytes.toString("utf8");
    for (const [label, pattern] of credentialPatterns) {
      if (pattern.test(contents)) patternHits.push({ path: relative, pattern: label });
    }
  }
}
assert.deepEqual(exactSecretHits, [], "evidence contains an exact protected value");
assert.deepEqual(patternHits, [], "evidence contains a credential-shaped value");
const result = {
  schemaVersion: 2,
  scannedAt: new Date().toISOString(),
  sourceCommit: productSourceCommit,
  productSourceCommit,
  selection: {
    method: "all regular files under evidence root plus every declared external evidence file",
    includesUntrackedFiles: true,
    excludedPaths,
    referencedExternalFiles: referencedEvidence.length,
    instance: {
      path: verifiedInstancePath.split(path.sep).join("/"),
      instanceId: instance.instanceId,
      sha256: createHash("sha256").update(instanceBytes).digest("hex"),
    },
    secrets: {
      path: verifiedSecretsPath.split(path.sep).join("/"),
      names: expectedSecretNames,
      sha256: createHash("sha256").update(secretsBytes).digest("hex"),
    },
  },
  scannedFileCount: files.length,
  protectedValueCount: protectedValues.length,
  exactSecretHits,
  credentialPatternHits: patternHits,
  credentialsPersisted: false,
  passed: true,
};
if (!dryRun) {
  const outputPath = await repoRegularFile(outputName, "secret scan output");
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify({ dryRun, ...result }, null, 2));
