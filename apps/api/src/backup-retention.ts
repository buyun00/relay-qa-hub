import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import {
  validateArchivedSqliteRecoveryPointWithAttachments,
  validateSqliteBackupBundle,
} from "@relay-qa-hub/storage";

const DAY_MS = 24 * 60 * 60 * 1000;
// Asia/Shanghai 09:00 is UTC 01:00 (independent of the host timezone).
const ANCHOR_UTC_MS = 60 * 60 * 1000;
const AUTOMATIC_NAME =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.sqlite$/u;

export interface RecoveryPoint {
  readonly backupPath: string;
  readonly createdAt: string;
}

export interface BackupRetentionResult {
  readonly policy: "latest-two-and-09-shanghai";
  readonly auditPath: string;
  readonly kept: readonly RecoveryPoint[];
  readonly deletedGroups: number;
  readonly deletedBytes: number;
  readonly skipped: readonly { backupPath: string; reason: string }[];
}

export function morningBoundary(nowMs: number): number {
  return Math.floor((nowMs - ANCHOR_UTC_MS) / DAY_MS) * DAY_MS + ANCHOR_UTC_MS;
}

export function nextBackupDelay(
  intervalMs: number,
  nowMs: number,
  latestCreatedAtMs: number,
): number {
  const boundary = morningBoundary(nowMs);
  if (latestCreatedAtMs < boundary) return 1;
  return Math.max(1, Math.min(intervalMs, boundary + DAY_MS - nowMs));
}

/** Keep the first successful point since 09:00, and the two newest points.
 * Before today's 09:00 point succeeds, the previous day's anchor remains.
 */
export function retainedRecoveryPoints(points: readonly RecoveryPoint[]): RecoveryPoint[] {
  const sorted = [...points].sort(
    (a, b) =>
      Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.backupPath.localeCompare(a.backupPath),
  );
  const latest = sorted[0];
  if (latest === undefined) return [];
  const boundary = morningBoundary(Date.parse(latest.createdAt));
  const anchor = sorted.findLast((point) => Date.parse(point.createdAt) >= boundary);
  return [...new Set([...sorted.slice(0, 2), ...(anchor === undefined ? [] : [anchor])])];
}

function equalPath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function ordinaryPath(path: string, directory: boolean): string {
  if (!isAbsolute(path)) throw new Error("Retention paths must be absolute");
  const requested = resolve(path);
  const stat = lstatSync(requested);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error(
      `Retention requires an ordinary ${directory ? "directory" : "file"}: ${requested}`,
    );
  }
  const canonical = realpathSync.native(requested);
  if (!equalPath(canonical, requested))
    throw new Error(`Retention refuses redirected path: ${requested}`);
  return canonical;
}

function directChild(path: string, parent: string, directory: boolean): string {
  ordinaryPath(parent, true);
  const canonical = ordinaryPath(path, directory);
  if (!equalPath(dirname(canonical), parent))
    throw new Error(`Retention path escaped root: ${path}`);
  return canonical;
}

function groupPaths(backupPath: string, rpoRoot: string, archived: boolean): string[] {
  if (!AUTOMATIC_NAME.test(basename(backupPath)))
    throw new Error("Not an automatic recovery point");
  const paths = [
    directChild(backupPath, rpoRoot, false),
    directChild(`${backupPath}.manifest.json`, rpoRoot, false),
  ];
  if (archived) paths.push(directChild(`${backupPath}.attachments`, rpoRoot, true));
  else if (existsSync(`${backupPath}.attachments`))
    throw new Error("Unexpected local attachment companion");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (existsSync(`${backupPath}${suffix}`))
      throw new Error("Recovery point has active SQLite sidecars");
  }
  return paths;
}

// Check every descendant before any recursive deletion; junctions must never
// redirect a cleanup into production data, another archive, or a VM directory.
function treeBytes(path: string): number {
  const stat = lstatSync(path);
  ordinaryPath(path, stat.isDirectory());
  if (stat.isFile()) return stat.size;
  let bytes = 0;
  for (const name of readdirSync(path)) bytes += treeBytes(join(path, name));
  return bytes;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function pruneRecoveryPoints(options: {
  readonly backupRoot: string;
  readonly archiveRoot: string;
  readonly successfulBackupName: string;
  readonly now?: Date;
  readonly dryRun?: boolean;
}): Promise<BackupRetentionResult> {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Invalid retention clock");
  if (!AUTOMATIC_NAME.test(options.successfulBackupName))
    throw new Error("Invalid successful backup name");
  const backupRoot = ordinaryPath(options.backupRoot, true);
  const archiveRoot = ordinaryPath(options.archiveRoot, true);
  const roots = [backupRoot, archiveRoot];
  if (
    roots.some((a, i) =>
      roots.some(
        (b, j) => i !== j && (equalPath(a, b) || equalPath(a.slice(0, b.length + 1), `${b}${sep}`)),
      ),
    )
  ) {
    throw new Error("Retention backup and archive roots must not overlap");
  }
  const skipped: { backupPath: string; reason: string }[] = [];
  const plans = roots.map((root, index) => {
    const archived = index === 1;
    const rpoRoot = directChild(join(root, "rpo"), root, true);
    const points: RecoveryPoint[] = [];
    for (const name of readdirSync(rpoRoot)) {
      if (!name.endsWith(".manifest.json")) continue;
      const backupPath = join(rpoRoot, name.slice(0, -".manifest.json".length));
      if (!AUTOMATIC_NAME.test(basename(backupPath))) continue;
      try {
        groupPaths(backupPath, rpoRoot, archived);
        const manifest = JSON.parse(readFileSync(`${backupPath}.manifest.json`, "utf8")) as {
          createdAt: string;
        };
        const timestamp = new Date(manifest.createdAt).toISOString();
        if (
          timestamp !== manifest.createdAt ||
          !basename(backupPath).startsWith(`${timestamp.replaceAll(":", "-")}.`)
        ) {
          throw new Error("Recovery point filename and timestamp do not match");
        }
        if (Date.parse(timestamp) > nowMs)
          throw new Error("Recovery point is newer than this retention run");
        points.push({ backupPath, createdAt: timestamp });
      } catch (error) {
        skipped.push({ backupPath, reason: errorMessage(error) });
      }
    }
    if (!points.some((point) => basename(point.backupPath) === options.successfulBackupName)) {
      throw new Error(`Successful recovery point is missing from ${rpoRoot}`);
    }
    return { root, rpoRoot, archived, points, kept: retainedRecoveryPoints(points) };
  });

  const validate = async (point: RecoveryPoint, plan: (typeof plans)[number]): Promise<void> => {
    groupPaths(point.backupPath, plan.rpoRoot, plan.archived);
    if (plan.archived) await validateArchivedSqliteRecoveryPointWithAttachments(point);
    else validateSqliteBackupBundle(point);
  };
  // Validate all retained recovery points on both volumes before deleting any.
  for (const plan of plans) {
    for (const point of plan.kept) await validate(point, plan);
    await validate(
      { backupPath: join(plan.rpoRoot, options.successfulBackupName), createdAt: "" },
      plan,
    );
  }
  const auditRoot = join(backupRoot, "retention-audit");
  if (!existsSync(auditRoot)) mkdirSync(auditRoot);
  directChild(auditRoot, backupRoot, true);
  const auditPath = join(
    auditRoot,
    `${now.toISOString().replaceAll(":", "-")}.${randomUUID()}.jsonl`,
  );
  const kept = plans.flatMap((plan) => plan.kept);
  const policy = "latest-two-and-09-shanghai" as const;
  const candidates = plans.flatMap((plan) =>
    plan.points.filter((point) => !plan.kept.includes(point)),
  );
  writeFileSync(
    auditPath,
    `${JSON.stringify({
      event: "plan",
      policy,
      dryRun: options.dryRun ?? false,
      createdAt: now.toISOString(),
      kept,
      candidates,
      skipped,
    })}\n`,
    { flag: "wx" },
  );
  let deletedGroups = 0;
  let deletedBytes = 0;
  for (const plan of plans) {
    for (const point of plan.points) {
      if (plan.kept.includes(point)) continue;
      try {
        await validate(point, plan);
        const paths = groupPaths(point.backupPath, plan.rpoRoot, plan.archived);
        const bytes = paths.reduce((sum, path) => sum + treeBytes(path), 0);
        appendFileSync(
          auditPath,
          `${JSON.stringify({ event: "validated", ...point, paths, bytes })}\n`,
        );
        if (options.dryRun) continue;
        // Re-resolve exact group roots immediately before deleting. Manifest is
        // last, so an interrupted cleanup remains visible as an incomplete group.
        groupPaths(point.backupPath, plan.rpoRoot, plan.archived);
        for (const path of [...paths]
          .reverse()
          .filter((path) => !path.endsWith(".manifest.json"))) {
          directChild(path, plan.rpoRoot, path.endsWith(".attachments"));
          rmSync(path, { recursive: path.endsWith(".attachments") });
        }
        rmSync(directChild(`${point.backupPath}.manifest.json`, plan.rpoRoot, false));
        if (paths.some((path) => existsSync(path))) throw new Error("Deleted group still exists");
        deletedGroups += 1;
        deletedBytes += bytes;
        appendFileSync(auditPath, `${JSON.stringify({ event: "deleted", ...point, bytes })}\n`);
      } catch (error) {
        const failure = { backupPath: point.backupPath, reason: errorMessage(error) };
        skipped.push(failure);
        appendFileSync(auditPath, `${JSON.stringify({ event: "skipped", ...failure })}\n`);
      }
    }
  }
  for (const plan of plans) for (const point of plan.kept) await validate(point, plan);
  const result = { policy, auditPath, kept, deletedGroups, deletedBytes, skipped };
  appendFileSync(auditPath, `${JSON.stringify({ event: "complete", ...result })}\n`);
  return result;
}
