import type { MobileMetricsOverview } from "@relay-qa-hub/storage";

export const MOBILE_METRICS_OVERVIEW_PATH = "/api/v1/projects/:projectId/metrics/overview" as const;
export const MOBILE_PROJECT_METRICS_OVERVIEW_PATH = MOBILE_METRICS_OVERVIEW_PATH;

export type { MobileMetricsOverview } from "@relay-qa-hub/storage";

export interface MobileMetricsOverviewQuery {
  readonly actorId: string;
  readonly projectId: string;
  readonly from: string;
  readonly to: string;
}

export interface MobileMetricsStore {
  readonly getOverview: (
    query: MobileMetricsOverviewQuery,
  ) => MobileMetricsOverview | Promise<MobileMetricsOverview>;
}

const QUERY_KEYS = new Set(["from", "to"]);
const CANONICAL_UTC_MILLISECONDS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_METRICS_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("metrics query must be an object");
  }
  return value as Record<string, unknown>;
}

function requireOnlyKeys(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (!QUERY_KEYS.has(key)) throw new TypeError(`unexpected query property: ${key}`);
  }
}

function requireQueryValue(value: unknown, key: string): string {
  if (Array.isArray(value) || typeof value !== "string") {
    throw new TypeError(`${key} must occur exactly once`);
  }
  return value;
}

function requireCanonicalUtcMilliseconds(value: string, key: string): void {
  if (!CANONICAL_UTC_MILLISECONDS_PATTERN.test(value)) {
    throw new TypeError(`${key} must be a canonical UTC ISO timestamp with milliseconds`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${key} is invalid`);
  }
}

/** Parse the exact two-parameter metrics query, including its bounded window. */
export function parseMobileMetricsOverviewQuery(value: unknown): {
  readonly from: string;
  readonly to: string;
} {
  const query = requireRecord(value);
  requireOnlyKeys(query);
  const from = requireQueryValue(query["from"], "from");
  const to = requireQueryValue(query["to"], "to");
  requireCanonicalUtcMilliseconds(from, "from");
  requireCanonicalUtcMilliseconds(to, "to");

  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (fromMs >= toMs) throw new TypeError("from must be before to");
  if (toMs - fromMs > MAX_METRICS_WINDOW_MS) {
    throw new TypeError("metrics window exceeds 366 days");
  }
  return Object.freeze({ from, to });
}
