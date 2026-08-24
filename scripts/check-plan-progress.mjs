import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const [plan, progress] = await Promise.all([
  readFile(path.join(repositoryRoot, "docs", "IMPLEMENTATION_PLAN.md"), "utf8"),
  readFile(path.join(repositoryRoot, "PROGRESS.md"), "utf8"),
]);

const planIds = [...plan.matchAll(/^####\s+(P(?:\d+|\d+A)\.\d+)\b/gmu)].map((match) => match[1]);
const progressIds = [...progress.matchAll(/^\|\s+(P(?:\d+|\d+A)\.\d+)\s+\|/gmu)].map(
  (match) => match[1],
);

const failures = [];

function findDuplicates(values) {
  return values.filter((value, index) => values.indexOf(value) !== index);
}

for (const duplicate of new Set(findDuplicates(planIds))) {
  failures.push(`duplicate plan work-package ID: ${duplicate}`);
}
for (const duplicate of new Set(findDuplicates(progressIds))) {
  failures.push(`duplicate progress work-package ID: ${duplicate}`);
}

const planSet = new Set(planIds);
const progressSet = new Set(progressIds);
for (const id of planSet) {
  if (!progressSet.has(id)) failures.push(`${id}: missing from PROGRESS.md`);
}
for (const id of progressSet) {
  if (!planSet.has(id)) failures.push(`${id}: missing from IMPLEMENTATION_PLAN.md`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Plan/progress check passed: ${planIds.length} unique work-package IDs match one-to-one.`,
  );
}
