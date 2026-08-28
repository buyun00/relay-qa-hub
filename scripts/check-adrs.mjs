import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const adrDirectory = path.join(repositoryRoot, "docs", "adr");

const adrFiles = [
  "ADR-0001-independent-source-of-truth.md",
  "ADR-0002-workflow-aggregate-separation.md",
  "ADR-0003-sqlite-wal-and-repository-boundary.md",
  "ADR-0004-content-addressed-evidence.md",
  "ADR-0005-reliable-integration-messaging.md",
  "ADR-0006-authentication-rbac-and-shared-devices.md",
  "ADR-0007-app-first-android-and-poco-bridge.md",
  "ADR-0008-optional-qingyu-adapter.md",
];

const requiredSections = [
  "## Context",
  "## Decision",
  "## Consequences",
  "## Rejected alternatives",
];

const failures = [];

for (const filename of adrFiles) {
  const body = await readFile(path.join(adrDirectory, filename), "utf8");

  if (!body.includes("- Status: Accepted")) {
    failures.push(`${filename}: status is not Accepted`);
  }

  let previousIndex = -1;
  for (const section of requiredSections) {
    const index = body.indexOf(section);
    if (index === -1) {
      failures.push(`${filename}: missing ${section}`);
      continue;
    }
    if (index <= previousIndex) {
      failures.push(`${filename}: ${section} is out of order`);
    }
    previousIndex = index;

    const contentStart = index + section.length;
    const nextSection = body.indexOf("\n## ", contentStart);
    const sectionBody = body
      .slice(contentStart, nextSection === -1 ? undefined : nextSection)
      .replace(/^#+ .*$/gm, "")
      .trim();
    if (sectionBody.length < 40) {
      failures.push(`${filename}: ${section} has no substantive content`);
    }
  }
}

const indexBody = await readFile(path.join(adrDirectory, "README.md"), "utf8");
for (let principle = 1; principle <= 10; principle += 1) {
  if (!indexBody.includes(`| ${principle}.`)) {
    failures.push(`README.md: immutable principle ${principle} is not mapped`);
  }
}

for (let adr = 1; adr <= 8; adr += 1) {
  const identifier = `ADR-${String(adr).padStart(4, "0")}`;
  if (!indexBody.includes(`[${identifier}]`)) {
    failures.push(`README.md: ${identifier} is not indexed`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `ADR check passed: ${adrFiles.length} accepted records, ${requiredSections.length} required sections each, 10/10 immutable principles mapped.`,
  );
}
