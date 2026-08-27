export const API_SERVICE_NAME = "relay-qa-hub-api" as const;
export const API_VERSION = "0.1.0-debug" as const;
export const DEFAULT_API_HOST = "127.0.0.1" as const;
export const DEFAULT_API_PORT = 4320 as const;
export const DEVELOPMENT_BUILD_SHA = "dev" as const;
export const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 2_000 as const;
export const DEFAULT_EVIDENCE_MIN_FREE_BYTES = 512 * 1024 * 1024;

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

export function resolveBuildSha(value: string | undefined): string {
  const buildSha = value ?? DEVELOPMENT_BUILD_SHA;

  if (buildSha !== DEVELOPMENT_BUILD_SHA && !GIT_SHA_PATTERN.test(buildSha)) {
    throw new Error("QA_HUB_BUILD_SHA must be 'dev' or a 40-character lowercase Git SHA");
  }

  return buildSha;
}

export function resolvePort(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_API_PORT;
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("QA_HUB_API_PORT must be an integer from 1 through 65535");
  }

  return port;
}

function resolveBoundedInteger(
  name: string,
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return defaultValue;
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

export function resolveHealthProbeTimeoutMs(value: string | undefined): number {
  return resolveBoundedInteger(
    "QA_HUB_HEALTH_PROBE_TIMEOUT_MS",
    value,
    DEFAULT_HEALTH_PROBE_TIMEOUT_MS,
    100,
    30_000,
  );
}

export function resolveEvidenceMinFreeBytes(value: string | undefined): number {
  return resolveBoundedInteger(
    "QA_HUB_EVIDENCE_MIN_FREE_BYTES",
    value,
    DEFAULT_EVIDENCE_MIN_FREE_BYTES,
    0,
    Number.MAX_SAFE_INTEGER,
  );
}
