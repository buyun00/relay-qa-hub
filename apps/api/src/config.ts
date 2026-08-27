export const API_SERVICE_NAME = "relay-qa-hub-api" as const;
export const API_VERSION = "0.1.0-debug" as const;
export const DEFAULT_API_HOST = "127.0.0.1" as const;
export const DEFAULT_API_PORT = 4320 as const;
export const DEVELOPMENT_BUILD_SHA = "dev" as const;
export const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 2_000 as const;
export const DEFAULT_EVIDENCE_MIN_FREE_BYTES = 512 * 1024 * 1024;
export const DEFAULT_WEB_ORIGIN = "http://127.0.0.1:4174" as const;

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

function normalizeWebOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("QA_HUB_WEB_ORIGINS must contain valid absolute origins");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error("QA_HUB_WEB_ORIGINS must contain only HTTP(S) origins without paths");
  }
  return parsed.origin;
}

export function resolveWebOrigins(
  values: string | undefined,
  legacyValue: string | undefined,
): readonly string[] {
  const configured = values?.trim();
  const legacy = legacyValue?.trim();
  if (configured && legacy) {
    throw new Error("Configure QA_HUB_WEB_ORIGINS or QA_HUB_WEB_ORIGIN, not both");
  }
  const entries = (configured || legacy || DEFAULT_WEB_ORIGIN)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0 || entries.length > 16) {
    throw new Error("QA_HUB_WEB_ORIGINS must contain from 1 through 16 origins");
  }
  return Object.freeze([...new Set(entries.map(normalizeWebOrigin))]);
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
