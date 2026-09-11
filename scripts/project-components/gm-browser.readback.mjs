import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readParallelInstanceConfig } from "../../apps/api/src/parallel-instance.ts";

const config = readParallelInstanceConfig(process.argv[2]);
const projectId = process.argv[3];
if (!/^[a-f0-9-]{36}$/u.test(projectId ?? ""))
  throw new Error("An explicit preview project ID is required");
const api = `http://${config.apiHost}:${config.apiPort}`;
const secrets = JSON.parse(readFileSync(config.secretsFile, "utf8"));
const scrub = (value) =>
  Array.isArray(value)
    ? value.map(scrub)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(
              ([key]) =>
                !/token|password|secret|cookie|authorization|joinCode|initializationLink/iu.test(
                  key,
                ),
            )
            .map(([key, item]) => [key, scrub(item)]),
        )
      : value;
const checks = [];
const login = await fetch(`${api}/api/v1/auth/gm/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: secrets.gmPassword, client: "android" }),
});
const identity = await login.json();
if (!login.ok || !identity.isGm || !identity.accessToken)
  throw new Error("Preview GM login failed");
async function read(label, route, expected, select = (value) => value) {
  const response = await fetch(api + route, {
    headers: { authorization: `Bearer ${identity.accessToken}`, "x-qa-project-id": projectId },
  });
  const value = select(await response.json());
  const passed = response.ok && expected(value);
  checks.push({
    label,
    method: "GET",
    path: route,
    status: response.status,
    passed,
    at: new Date().toISOString(),
    response: scrub(value),
  });
  return value;
}
await read(
  "preview remains ready at schema14",
  "/api/v1/health/ready",
  (value) => value.status === "ready" && value.schemaVersion === "14",
);
await read(
  "browser project restored with stable ID and shortcode",
  "/api/v1/gm/projects",
  (value) => value?.id === projectId && value.active && value.version === 5,
  (value) => value.items.find((item) => item.id === projectId),
);
await read(
  "all five components off and disabled build configuration persisted",
  `/api/v1/projects/${projectId}/components`,
  (value) =>
    value.items.length === 5 &&
    value.items.every((item) => !item.enabled) &&
    value.items.find((item) => item.key === "build")?.version === 2 &&
    value.items.find((item) => item.key === "build")?.config.job === "gm-ui-disabled-fixture" &&
    value.items.find((item) => item.key === "build")?.config.presets?.uiFixture?.preview === "true",
);
await read(
  "browser membership restored at version3",
  `/api/v1/projects/${projectId}/users`,
  (value) =>
    value.items.find((item) => item.userId === "b32a6f48-2bb1-4eea-8354-a53361deb242")
      ?.membershipVersion === 3 &&
    value.items.find((item) => item.userId === "b32a6f48-2bb1-4eea-8354-a53361deb242")
      ?.membershipStatus === "active",
);
await read(
  "no build task created by configuration edits",
  `/api/v1/projects/${projectId}/packaging/tasks`,
  (value) => value.items.length === 0,
);
const report = {
  recordedAt: new Date().toISOString(),
  projectId,
  api,
  passed: checks.every((check) => check.passed),
  checks,
  note: "Read-only readback after actual browser writes. Authentication credentials stay in process memory and are excluded from evidence.",
};
const output = join(
  config.sourceRoot,
  "docs/evidence/project-components/web-browser/gm-http-readback.json",
);
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    passed: report.passed,
    checks: checks.length,
    output,
    failed: checks.filter((check) => !check.passed).map((check) => check.label),
  }),
);
if (!report.passed) process.exitCode = 1;
