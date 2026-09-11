import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const ANDROID_UPDATE_PATH = "/api/v1/android-updates/stable/:fileName" as const;
const ANDROID_PREVIEW_UPDATE_PATH = "/api/v1/android-updates/preview/:fileName" as const;
export type AndroidUpdateChannel = "stable" | "preview";

/** Only registered distribution reads are public; neighboring routes stay protected. */
export function isAndroidUpdateReadRoute(request: FastifyRequest): boolean {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    (request.routeOptions.url === ANDROID_UPDATE_PATH ||
      request.routeOptions.url === ANDROID_PREVIEW_UPDATE_PATH)
  );
}

export function parseAndroidUpdateChannel(value: string | undefined): AndroidUpdateChannel {
  if (value === undefined) return "stable";
  if (value === "stable" || value === "preview") return value;
  throw new Error("QA_HUB_ANDROID_UPDATE_CHANNEL must be stable or preview");
}

const UPDATE_FILE_PATTERN =
  /^(?:latest\.json|Relay-QA-Hub-Android-[1-9][0-9]{0,9}-[0-9A-Za-z][0-9A-Za-z.+-]{0,63}\.apk)$/u;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_APK_BYTES = 512 * 1024 * 1024;

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

function maximumBytes(fileName: string): number {
  return fileName === "latest.json" ? MAX_METADATA_BYTES : MAX_APK_BYTES;
}

function parseSingleRange(value: string | undefined, size: number): ByteRange | null | "invalid" {
  if (value === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (match === null || (match[1]?.length === 0 && match[2]?.length === 0)) return "invalid";
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText.length === 0) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startText);
  const requestedEnd = endText.length === 0 ? size - 1 : Number(endText);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= size
  ) {
    return "invalid";
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

async function ordinaryContainedPath(root: string, fileName: string): Promise<string | null> {
  if (!UPDATE_FILE_PATTERN.test(fileName) || basename(fileName) !== fileName) return null;
  try {
    const canonicalRoot = await realpath(root);
    const canonicalFile = await realpath(resolve(canonicalRoot, fileName));
    if (!canonicalFile.startsWith(`${canonicalRoot}${sep}`)) return null;
    const result = await stat(canonicalFile);
    if (!result.isFile() || result.size <= 0 || result.size > maximumBytes(fileName)) return null;
    return canonicalFile;
  } catch {
    return null;
  }
}

function weakEtag(size: number, modifiedMs: number): string {
  return `W/"${size.toString(16)}-${Math.trunc(modifiedMs).toString(16)}"`;
}

async function previewMetadata(
  filePath: string,
  expectedPackageName: string,
): Promise<Buffer | null> {
  try {
    const bytes = await readFile(filePath);
    if (bytes.length > MAX_METADATA_BYTES) return null;
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const versionCode = record["versionCode"];
    const versionName = record["versionName"];
    const size = record["size"];
    if (
      record["schemaVersion"] !== 1 ||
      record["channel"] !== "preview" ||
      record["packageName"] !== expectedPackageName ||
      typeof versionCode !== "number" ||
      !Number.isSafeInteger(versionCode) ||
      versionCode <= 0 ||
      typeof versionName !== "string" ||
      !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(versionName) ||
      typeof record["fileName"] !== "string" ||
      !UPDATE_FILE_PATTERN.test(record["fileName"]) ||
      record["fileName"] !== `Relay-QA-Hub-Android-${versionCode}-${versionName}.apk` ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > MAX_APK_BYTES ||
      typeof record["sha256"] !== "string" ||
      !/^[0-9a-f]{64}$/iu.test(record["sha256"])
    ) {
      return null;
    }
    return bytes;
  } catch {
    return null;
  }
}

export function registerAndroidUpdateRoutes(
  app: FastifyInstance,
  root: string | undefined,
  channel: AndroidUpdateChannel = "stable",
  previewPackageName = "com.relayqahub.android.preview.debug",
): void {
  const configuredChannel = parseAndroidUpdateChannel(channel);
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u.test(previewPackageName))
    throw new Error("Android preview update package name is invalid");
  const handler = async (
    request: FastifyRequest<{ Params: { fileName: string } }>,
    reply: FastifyReply,
  ) => {
    if (root === undefined) return reply.code(404).send({ code: "ANDROID_UPDATE_NOT_CONFIGURED" });
    const fileName = request.params.fileName;
    const filePath = await ordinaryContainedPath(root, fileName);
    if (filePath === null) return reply.code(404).send({ code: "ANDROID_UPDATE_NOT_FOUND" });
    const fileStat = await stat(filePath);
    const metadata = fileName === "latest.json";
    const metadataBytes =
      metadata && configuredChannel === "preview"
        ? await previewMetadata(filePath, previewPackageName)
        : undefined;
    if (metadataBytes === null) {
      return reply
        .code(503)
        .header("cache-control", "no-store")
        .send({ code: "ANDROID_UPDATE_METADATA_INVALID" });
    }
    const size = metadataBytes?.length ?? fileStat.size;
    const etag = weakEtag(size, fileStat.mtimeMs);
    reply
      .header("accept-ranges", "bytes")
      .header("cache-control", metadata ? "no-store" : "public, max-age=31536000, immutable")
      .header(
        "content-type",
        metadata ? "application/json; charset=utf-8" : "application/vnd.android.package-archive",
      )
      .header(
        "content-disposition",
        `${metadata ? "inline" : "attachment"}; filename="${fileName}"`,
      )
      .header("etag", etag)
      .header("x-content-type-options", "nosniff");
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();
    const range = parseSingleRange(
      typeof request.headers.range === "string" ? request.headers.range : undefined,
      size,
    );
    if (range === "invalid") {
      return reply.code(416).header("content-range", `bytes */${size}`).send();
    }
    if (request.method === "HEAD") {
      return reply.header("content-length", size).send();
    }
    if (range === null) {
      return reply.header("content-length", size).send(metadataBytes ?? createReadStream(filePath));
    }
    return reply
      .code(206)
      .header("content-length", range.end - range.start + 1)
      .header("content-range", `bytes ${range.start}-${range.end}/${size}`)
      .send(
        metadataBytes?.subarray(range.start, range.end + 1) ??
          createReadStream(filePath, { start: range.start, end: range.end }),
      );
  };

  app.route({
    method: ["GET", "HEAD"],
    url: configuredChannel === "preview" ? ANDROID_PREVIEW_UPDATE_PATH : ANDROID_UPDATE_PATH,
    handler,
  });
}
