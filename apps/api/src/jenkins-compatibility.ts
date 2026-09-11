import { inflateSync } from "node:zlib";

/** Accept only the two checker modules embedded by the existing trusted job. */
export function compatibilitySource(config: string): string {
  const encoded = /base64\.b64decode\([^A-Za-z0-9+/=]*([A-Za-z0-9+/=]{100,200000})/.exec(
    config,
  )?.[1];
  if (!encoded) throw new Error("CHECK_SOURCE_CHANGED");
  try {
    const modules = JSON.parse(
      inflateSync(Buffer.from(encoded, "base64"), { maxOutputLength: 2_000_000 }).toString("utf8"),
    ) as Record<string, unknown>;
    if (
      Object.keys(modules).sort().join(",") !==
        "BuildCompatibility.py,CheckPlayerRebuildRequired.py" ||
      Object.values(modules).some((v) => typeof v !== "string" || !v)
    )
      throw new Error();
  } catch {
    throw new Error("CHECK_SOURCE_CHANGED");
  }
  return encoded;
}

export const COMPATIBILITY_TARGETS = [
  { id: "android-debug", platform: "Android", configuration: "Debug" },
  { id: "android-release", platform: "Android", configuration: "Release" },
  { id: "ios-debug", platform: "iOS", configuration: "Debug" },
  { id: "ios-release", platform: "iOS", configuration: "Release" },
] as const;
export type CompatibilityTarget = (typeof COMPATIBILITY_TARGETS)[number];
export interface CompatibilityReport {
  result: "PLAYER_REBUILD_REQUIRED" | "HOT_UPDATE_ALLOWED" | "NO_BASELINE" | "UNKNOWN";
  targetRevision: string | null;
  baseRevision: string | null;
  selectedVersion: string | null;
  playerVersion: string | null;
  commitCount: number;
  changeCount: number;
  changeCounts: Record<string, number>;
}
export interface CompatibilityCheck {
  target: CompatibilityTarget;
  state: "pending" | "submitting" | "queued" | "running" | "complete" | "error";
  queueId: number | null;
  buildNumber: number | null;
  checkedAt: string | null;
  reportUrl: string | null;
  errorCode: string | null;
  report: CompatibilityReport | null;
}
export function validateCompatibilityReport(
  value: unknown,
  target: CompatibilityTarget,
): CompatibilityReport {
  if (!value || typeof value !== "object") throw new Error("CHECK_INVALID_REPORT");
  const r = value as Record<string, unknown>;
  const result = r["result"];
  const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/u.test(v);
  const ref = (v: unknown): v is string =>
    typeof v === "string" &&
    new RegExp(
      "^" + target.platform + "/" + target.configuration + "/[0-9]+\\.[0-9]+\\.[0-9]+/[1-9][0-9]*$",
      "u",
    ).test(v);
  if (
    r["platform"] !== target.platform ||
    r["configuration"] !== target.configuration ||
    r["selection"] !== "latest" ||
    !["PLAYER_REBUILD_REQUIRED", "HOT_UPDATE_ALLOWED", "NO_BASELINE", "UNKNOWN"].includes(
      String(result),
    ) ||
    !Array.isArray(r["commits"]) ||
    !Array.isArray(r["changes"]) ||
    !r["commits"].every((c) => typeof c === "string" && /^[a-f0-9]{40}(?: |$)/u.test(c))
  )
    throw new Error("CHECK_INVALID_REPORT");
  const confirmed = result === "PLAYER_REBUILD_REQUIRED" || result === "HOT_UPDATE_ALLOWED";
  if (
    confirmed &&
    (!sha(r["targetRevision"]) ||
      !sha(r["baseRevision"]) ||
      !ref(r["selectedVersion"]) ||
      !ref(r["playerVersion"]) ||
      !Array.isArray(r["chain"]) ||
      !r["chain"].length ||
      !r["chain"].every(ref) ||
      r["chain"][0] !== r["selectedVersion"] ||
      r["chain"].at(-1) !== r["playerVersion"] ||
      r["requiresPlayerRebuild"] !== (result === "PLAYER_REBUILD_REQUIRED"))
  )
    throw new Error("CHECK_INVALID_REPORT");
  const counts: Record<string, number> = { player: 0, hot_update: 0, build_only: 0, asset_only: 0 };
  for (const entry of r["changes"]) {
    const category =
      entry && typeof entry === "object" ? (entry as Record<string, unknown>)["category"] : null;
    if (typeof category !== "string" || !Object.hasOwn(counts, category))
      throw new Error("CHECK_INVALID_REPORT");
    counts[category]!++;
  }
  if (confirmed && Boolean(counts["player"]) !== (result === "PLAYER_REBUILD_REQUIRED"))
    throw new Error("CHECK_INVALID_REPORT");
  return {
    result: result as CompatibilityReport["result"],
    targetRevision: sha(r["targetRevision"]) ? r["targetRevision"] : null,
    baseRevision: sha(r["baseRevision"]) ? r["baseRevision"] : null,
    selectedVersion: ref(r["selectedVersion"]) ? r["selectedVersion"] : null,
    playerVersion: ref(r["playerVersion"]) ? r["playerVersion"] : null,
    commitCount: r["commits"].length,
    changeCount: r["changes"].length,
    changeCounts: counts,
  };
}
