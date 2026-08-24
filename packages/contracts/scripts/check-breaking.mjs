import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const contractRoot = fileURLToPath(new URL("..", import.meta.url));
const baselinePath = path.join(contractRoot, "baselines", "contract-baseline.json");
const includedDirectories = [
  "openapi",
  "schemas",
  "state",
  "errors",
  "examples",
  "semantics",
  "src",
  "scripts",
];
const frozenExtensions = new Set([".json", ".md", ".mjs"]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

async function collectFrozenFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = path.join(prefix, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFrozenFiles(absolutePath, relativePath)));
    } else if (entry.isFile() && frozenExtensions.has(path.extname(entry.name))) {
      files.push(relativePath.replaceAll("\\", "/"));
    }
  }
  return files;
}

const relativeFiles = [];
for (const directory of includedDirectories) {
  const files = await collectFrozenFiles(path.join(contractRoot, directory), directory);
  relativeFiles.push(...files);
}
relativeFiles.push("README.md", "../../docs/contracts/CRITICAL_SCENARIOS.md");

const hashes = {};
for (const relativePath of relativeFiles.sort()) {
  const body = await readFile(path.join(contractRoot, relativePath), "utf8");
  const normalized = relativePath.endsWith(".json")
    ? JSON.stringify(canonicalize(JSON.parse(body)))
    : body.replaceAll("\r\n", "\n");
  hashes[relativePath] = createHash("sha256").update(normalized).digest("hex");
}

if (process.argv.includes("--write-baseline")) {
  const manifest = JSON.parse(
    await readFile(path.join(contractRoot, "src", "api-manifest.json"), "utf8"),
  );
  const baseline = {
    contractVersion: manifest.contractVersion,
    frozenAt: new Date().toISOString(),
    canonicalSha256: hashes,
  };
  await mkdir(path.dirname(baselinePath), { recursive: true });
  await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  console.log(`Wrote strict contract baseline for ${relativeFiles.length} frozen contract and semantic files.`);
} else {
  let baseline;
  try {
    baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  } catch (error) {
    console.error(`Contract baseline is missing or unreadable: ${error.message}`);
    process.exit(1);
  }

  const drift = [];
  const allPaths = new Set([
    ...Object.keys(baseline.canonicalSha256),
    ...Object.keys(hashes),
  ]);
  for (const relativePath of [...allPaths].sort()) {
    if (!(relativePath in baseline.canonicalSha256)) {
      drift.push(`${relativePath}: added without an explicit baseline review`);
    } else if (!(relativePath in hashes)) {
      drift.push(`${relativePath}: removed`);
    } else if (baseline.canonicalSha256[relativePath] !== hashes[relativePath]) {
      drift.push(`${relativePath}: canonical contract changed`);
    }
  }

  if (drift.length > 0) {
    console.error(
      `Contract drift detected. Review compatibility and deliberately run --write-baseline only after approval:\n${drift.join("\n")}`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Breaking-change check passed: ${relativeFiles.length} frozen contract and semantic files match version ${baseline.contractVersion}.`,
    );
  }
}
