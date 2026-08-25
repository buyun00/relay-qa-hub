export const MOBILE_BUILD_COLLECTION_PATH = "/api/v1/projects/:projectId/builds" as const;
export const MOBILE_BUILD_ITEM_PATH = "/api/v1/builds/:buildId" as const;
export const MOBILE_BUILD_LINK_REPAIR_PATH = "/api/v1/builds/:buildId/link-repair" as const;

export interface MobileRegisterBuildRequest {
  readonly provider: "manual";
  readonly externalId: string;
  readonly version: string;
  readonly channel: string;
  readonly projectKey: string;
  readonly branch: string;
  readonly sourceCommitSha: string;
  readonly mode: "debug";
  readonly status: "ready";
  readonly resourceVersion?: string | null;
  readonly downloadUrl: string;
  readonly manifest: {
    readonly commitShas: readonly string[];
    readonly artifactSha256: string;
    readonly providerPayloadDigest?: string;
  };
  readonly repairAttemptId?: string;
}

export interface MobileLinkBuildRepairRequest {
  readonly expectedVersion: number;
  readonly expectedBugVersion?: number;
  readonly expectedBuildRequirementVersion?: number;
  readonly repairAttemptId: string;
  readonly deliveredCommitSha: string;
  readonly evidenceType: "manifest";
}

export interface MobileBuildStore {
  readonly registerBuild: (command: {
    readonly actorId: string;
    readonly projectId: string;
    readonly idempotencyKey: string;
    readonly request: MobileRegisterBuildRequest;
  }) => unknown | Promise<unknown>;
  readonly getBuild: (query: {
    readonly actorId: string;
    readonly buildId: string;
  }) => unknown | null | Promise<unknown | null>;
  readonly linkRepair: (command: {
    readonly actorId: string;
    readonly buildId: string;
    readonly idempotencyKey: string;
    readonly request: MobileLinkBuildRepairRequest;
  }) => unknown | Promise<unknown>;
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,15}$/u;

function record(value: unknown, label = "request body"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`unexpected property: ${key}`);
  }
}

function boundedString(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new TypeError(`${label} must be a bounded string`);
  }
  return value;
}

function optionalBoundedString(
  value: unknown,
  label: string,
  maximum: number,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  return boundedString(value, label, 1, maximum);
}

function commitSha(value: unknown, label: string): string {
  const candidate = boundedString(value, label, 40, 40);
  if (!COMMIT_SHA_PATTERN.test(candidate)) throw new TypeError(`${label} must be a Git SHA`);
  return candidate;
}

function sha256(value: unknown, label: string): string {
  const candidate = boundedString(value, label, 64, 64);
  if (!SHA256_PATTERN.test(candidate)) throw new TypeError(`${label} must be a SHA-256 digest`);
  return candidate;
}

function absoluteUrl(value: unknown, label: string): string {
  const candidate = boundedString(value, label, 1, 4_000);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new TypeError(`${label} must be an absolute URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(`${label} must use HTTP or HTTPS`);
  }
  return candidate;
}

export function requireBuildUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a UUID`);
  }
  return value;
}

export function requireBuildIdempotencyKey(value: string | undefined): string {
  if (value === undefined || value.length < 1 || value.length > 200) {
    throw new TypeError("Idempotency-Key is required");
  }
  return value;
}

export function parseMobileRegisterBuildRequest(value: unknown): MobileRegisterBuildRequest {
  const body = record(value);
  onlyKeys(
    body,
    new Set([
      "provider",
      "externalId",
      "version",
      "channel",
      "projectKey",
      "branch",
      "sourceCommitSha",
      "mode",
      "status",
      "resourceVersion",
      "downloadUrl",
      "manifest",
      "repairAttemptId",
    ]),
  );
  if (body["provider"] !== "manual") throw new TypeError("provider must be manual");
  if (body["mode"] !== "debug") throw new TypeError("mode must be debug");
  if (body["status"] !== "ready") throw new TypeError("status must be ready");
  const projectKey = boundedString(body["projectKey"], "projectKey", 2, 16);
  if (!PROJECT_KEY_PATTERN.test(projectKey)) throw new TypeError("projectKey is invalid");

  const manifest = record(body["manifest"], "manifest");
  onlyKeys(manifest, new Set(["commitShas", "artifactSha256", "providerPayloadDigest"]));
  if (!Array.isArray(manifest["commitShas"]) || manifest["commitShas"].length < 1) {
    throw new TypeError("manifest.commitShas must not be empty");
  }
  const commitShas = manifest["commitShas"].map((entry) =>
    commitSha(entry, "manifest.commitSha"),
  );
  if (new Set(commitShas).size !== commitShas.length) {
    throw new TypeError("manifest.commitShas must be unique");
  }
  const resourceVersion = optionalBoundedString(body["resourceVersion"], "resourceVersion", 100);
  const providerPayloadDigest = manifest["providerPayloadDigest"];
  return {
    provider: "manual",
    externalId: boundedString(body["externalId"], "externalId", 1, 300),
    version: boundedString(body["version"], "version", 1, 100),
    channel: boundedString(body["channel"], "channel", 1, 100),
    projectKey,
    branch: boundedString(body["branch"], "branch", 1, 300),
    sourceCommitSha: commitSha(body["sourceCommitSha"], "sourceCommitSha"),
    mode: "debug",
    status: "ready",
    ...(resourceVersion === undefined ? {} : { resourceVersion }),
    downloadUrl: absoluteUrl(body["downloadUrl"], "downloadUrl"),
    manifest: {
      commitShas,
      artifactSha256: sha256(manifest["artifactSha256"], "manifest.artifactSha256"),
      ...(providerPayloadDigest === undefined
        ? {}
        : { providerPayloadDigest: sha256(providerPayloadDigest, "manifest.providerPayloadDigest") }),
    },
    ...(body["repairAttemptId"] === undefined
      ? {}
      : { repairAttemptId: requireBuildUuid(body["repairAttemptId"], "repairAttemptId") }),
  };
}

export function parseMobileLinkBuildRepairRequest(value: unknown): MobileLinkBuildRepairRequest {
  const body = record(value);
  onlyKeys(
    body,
    new Set([
      "expectedVersion",
      "expectedBugVersion",
      "expectedBuildRequirementVersion",
      "repairAttemptId",
      "deliveredCommitSha",
      "evidenceType",
    ]),
  );
  if (body["evidenceType"] !== "manifest") {
    throw new TypeError("evidenceType must be manifest");
  }
  const version = body["expectedVersion"];
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    throw new TypeError("expectedVersion must be a positive integer");
  }
  const optionalVersion = (candidate: unknown, label: string): number | undefined => {
    if (candidate === undefined) return undefined;
    if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) {
      throw new TypeError(`${label} must be a positive integer`);
    }
    return candidate as number;
  };
  const deliveredCommitSha = commitSha(body["deliveredCommitSha"], "deliveredCommitSha");
  return {
    expectedVersion: version as number,
    ...(optionalVersion(body["expectedBugVersion"], "expectedBugVersion") === undefined
      ? {}
      : {
          expectedBugVersion: optionalVersion(body["expectedBugVersion"], "expectedBugVersion")!,
        }),
    ...(optionalVersion(body["expectedBuildRequirementVersion"], "expectedBuildRequirementVersion") ===
    undefined
      ? {}
      : {
          expectedBuildRequirementVersion: optionalVersion(
            body["expectedBuildRequirementVersion"],
            "expectedBuildRequirementVersion",
          )!,
        }),
    repairAttemptId: requireBuildUuid(body["repairAttemptId"], "repairAttemptId"),
    deliveredCommitSha,
    evidenceType: "manifest",
  };
}
