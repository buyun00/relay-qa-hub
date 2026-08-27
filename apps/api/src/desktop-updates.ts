import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const DESKTOP_UPDATE_PATH = "/api/v1/desktop-updates/stable/:fileName" as const;

const UPDATE_FILE_PATTERN =
  /^(?:latest\.yml|Relay-QA-Hub-Setup-[0-9A-Za-z][0-9A-Za-z.+-]{0,63}-x64\.exe(?:\.blockmap)?)$/u;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_BLOCKMAP_BYTES = 32 * 1024 * 1024;
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;

interface ByteRange {
  readonly start: number;
  readonly end: number;
}

function contentType(fileName: string): string {
  if (fileName === "latest.yml") return "application/yaml; charset=utf-8";
  if (fileName.endsWith(".blockmap")) return "application/octet-stream";
  return "application/vnd.microsoft.portable-executable";
}

function maximumBytes(fileName: string): number {
  if (fileName === "latest.yml") return MAX_METADATA_BYTES;
  if (fileName.endsWith(".blockmap")) return MAX_BLOCKMAP_BYTES;
  return MAX_INSTALLER_BYTES;
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
  let canonicalRoot: string;
  let canonicalFile: string;
  try {
    canonicalRoot = await realpath(root);
    canonicalFile = await realpath(resolve(canonicalRoot, fileName));
  } catch {
    return null;
  }
  if (!canonicalFile.startsWith(`${canonicalRoot}${sep}`)) return null;
  const result = await stat(canonicalFile);
  if (!result.isFile() || result.size <= 0 || result.size > maximumBytes(fileName)) return null;
  return canonicalFile;
}

function weakEtag(size: number, modifiedMs: number): string {
  return `W/\"${size.toString(16)}-${Math.trunc(modifiedMs).toString(16)}\"`;
}

export function registerDesktopUpdateRoutes(app: FastifyInstance, root: string | undefined): void {
  const handler = async (
    request: FastifyRequest<{ Params: { fileName: string } }>,
    reply: FastifyReply,
  ) => {
    if (root === undefined) return reply.code(404).send({ code: "DESKTOP_UPDATE_NOT_CONFIGURED" });
    const fileName = request.params.fileName;
    const filePath = await ordinaryContainedPath(root, fileName);
    if (filePath === null) return reply.code(404).send({ code: "DESKTOP_UPDATE_NOT_FOUND" });
    const fileStat = await stat(filePath);
    const etag = weakEtag(fileStat.size, fileStat.mtimeMs);
    const cacheControl =
      fileName === "latest.yml" ? "no-store" : "public, max-age=31536000, immutable";
    reply
      .header("accept-ranges", "bytes")
      .header("cache-control", cacheControl)
      .header("content-type", contentType(fileName))
      .header("content-disposition", `inline; filename=\"${fileName}\"`)
      .header("etag", etag)
      .header("x-content-type-options", "nosniff");
    if (request.headers["if-none-match"] === etag) return reply.code(304).send();
    const range = parseSingleRange(
      typeof request.headers.range === "string" ? request.headers.range : undefined,
      fileStat.size,
    );
    if (range === "invalid") {
      return reply.code(416).header("content-range", `bytes */${fileStat.size}`).send();
    }
    if (request.method === "HEAD") {
      return reply.header("content-length", fileStat.size).send();
    }
    if (range === null) {
      return reply.header("content-length", fileStat.size).send(createReadStream(filePath));
    }
    return reply
      .code(206)
      .header("content-length", range.end - range.start + 1)
      .header("content-range", `bytes ${range.start}-${range.end}/${fileStat.size}`)
      .send(createReadStream(filePath, { start: range.start, end: range.end }));
  };

  app.route({ method: ["GET", "HEAD"], url: DESKTOP_UPDATE_PATH, handler });
}
