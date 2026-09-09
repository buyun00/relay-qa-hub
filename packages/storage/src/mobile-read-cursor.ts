import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";

import { MobileRelayStorageError } from "./mobile-relay-store.js";

const CURSOR_PREFIX = "r1";
const CURSOR_PATTERN = /^r1\.[A-Za-z0-9_-]{1,410}\.[A-Za-z0-9_-]{43}$/u;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const KIND_PATTERN = /^[a-z][a-z0-9-]{0,39}$/u;
const ENVELOPE_KEYS = new Set(["a", "f", "k", "p", "s", "v"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new MobileRelayStorageError("INVALID_REQUEST", "cursor contains invalid JSON");
  }
  return encoded;
}

function requireSigningKey(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new TypeError("mobile read cursor signing key must contain exactly 32 bytes");
  }
}

function invalidCursor(): never {
  throw new MobileRelayStorageError("INVALID_REQUEST", "cursor is invalid for this list");
}

export function digestMobileReadBinding(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("base64url");
}

export interface MobileReadCursorValue {
  readonly kind: string;
  readonly authorizationDigest: string;
  readonly filterDigest: string;
  readonly snapshotSequence: number;
  readonly position: unknown;
}

export function encodeMobileReadCursor(
  value: MobileReadCursorValue,
  signingKey: Uint8Array,
): string {
  requireSigningKey(signingKey);
  if (
    !KIND_PATTERN.test(value.kind) ||
    !DIGEST_PATTERN.test(value.authorizationDigest) ||
    !DIGEST_PATTERN.test(value.filterDigest) ||
    !Number.isSafeInteger(value.snapshotSequence) ||
    value.snapshotSequence < 0
  ) {
    throw new TypeError("mobile read cursor value is invalid");
  }
  const encoded = Buffer.from(
    canonicalJson({
      a: value.authorizationDigest,
      f: value.filterDigest,
      k: value.kind,
      p: value.position,
      s: value.snapshotSequence,
      v: 1,
    }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", signingKey)
    .update(`${CURSOR_PREFIX}.${encoded}`)
    .digest("base64url");
  const token = `${CURSOR_PREFIX}.${encoded}.${signature}`;
  if (token.length > 500) throw new TypeError("mobile read cursor exceeds 500 characters");
  return token;
}

export function decodeMobileReadCursor(
  token: string | undefined,
  expected: Readonly<{
    kind: string;
    authorizationDigest: string | ((snapshotSequence: number) => string);
    filterDigest: string;
    signingKey: Uint8Array;
  }>,
): { readonly snapshotSequence: number; readonly position: unknown } | null {
  if (token === undefined) return null;
  requireSigningKey(expected.signingKey);
  if (token.length > 500 || !CURSOR_PATTERN.test(token)) invalidCursor();
  const [, encoded, signature] = token.split(".");
  if (encoded === undefined || signature === undefined) invalidCursor();
  const calculated = createHmac("sha256", expected.signingKey)
    .update(`${CURSOR_PREFIX}.${encoded}`)
    .digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, "base64url");
  } catch {
    invalidCursor();
  }
  if (
    received.toString("base64url") !== signature ||
    received.byteLength !== calculated.byteLength ||
    !timingSafeEqual(received, calculated)
  ) {
    invalidCursor();
  }

  let text: string;
  let decoded: unknown;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) invalidCursor();
    text = UTF8_DECODER.decode(bytes);
    decoded = JSON.parse(text);
  } catch {
    invalidCursor();
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) invalidCursor();
  const value = decoded as Record<string, unknown>;
  if (
    Object.keys(value).length !== ENVELOPE_KEYS.size ||
    Object.keys(value).some((key) => !ENVELOPE_KEYS.has(key)) ||
    value["v"] !== 1 ||
    value["k"] !== expected.kind ||
    !Number.isSafeInteger(value["s"]) ||
    (value["s"] as number) < 0 ||
    value["a"] !==
      (typeof expected.authorizationDigest === "function"
        ? expected.authorizationDigest(value["s"] as number)
        : expected.authorizationDigest) ||
    value["f"] !== expected.filterDigest ||
    !DIGEST_PATTERN.test(String(value["a"] ?? "")) ||
    !DIGEST_PATTERN.test(String(value["f"] ?? "")) ||
    canonicalJson(value) !== text
  ) {
    invalidCursor();
  }
  return Object.freeze({
    snapshotSequence: value["s"] as number,
    position: value["p"],
  });
}

export function requireMobileReadPosition(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidCursor();
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  if (
    Object.keys(record).length !== allowed.size ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    invalidCursor();
  }
  return record;
}
