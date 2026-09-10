import { promises as fs } from "node:fs";
import path from "node:path";

const RELAUNCH_MARKER_ARGUMENT = "--update-relaunch-marker=";
const UPDATER_DIRECTORY_PATTERN = /^updater-\d{8}T\d{9}Z-\d+-[0-9a-f-]{36}$/iu;

export interface UpdateRelaunchAcknowledgement {
  readonly schemaVersion: 1;
  readonly status: "ready";
  readonly version: string;
  readonly pid: number;
  readonly recordedAt: string;
}

export function resolveUpdateRelaunchMarker(
  argv: readonly string[],
  updatesDirectory: string,
): string | null {
  const values = argv
    .filter((argument) => argument.startsWith(RELAUNCH_MARKER_ARGUMENT))
    .map((argument) => argument.slice(RELAUNCH_MARKER_ARGUMENT.length));
  if (values.length !== 1 || values[0] === "" || values[0]!.length > 1_024) return null;
  const root = path.resolve(updatesDirectory);
  const candidate = path.resolve(values[0]!);
  const relative = path.relative(root, candidate);
  if (relative === "" || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) {
    return null;
  }
  const segments = relative.split(path.sep);
  if (
    segments.length !== 2 ||
    segments[1] !== "relaunched.flag" ||
    !UPDATER_DIRECTORY_PATTERN.test(segments[0]!)
  ) {
    return null;
  }
  return candidate;
}

export async function acknowledgeUpdateRelaunch(options: {
  readonly argv: readonly string[];
  readonly updatesDirectory: string;
  readonly version: string;
  readonly pid?: number;
  readonly now?: () => Date;
}): Promise<string | null> {
  const marker = resolveUpdateRelaunchMarker(options.argv, options.updatesDirectory);
  if (marker === null) return null;
  const acknowledgement: UpdateRelaunchAcknowledgement = {
    schemaVersion: 1,
    status: "ready",
    version: options.version,
    pid: options.pid ?? process.pid,
    recordedAt: (options.now?.() ?? new Date()).toISOString(),
  };
  await fs.writeFile(marker, `${JSON.stringify(acknowledgement)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return marker;
}
