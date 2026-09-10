import { createHash } from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ACTIVATION_ARGUMENT_PATTERN =
  /^(?:type=click&tag=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})|tag=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})&type=click)$/iu;
const UPDATE_RELEASE_ID_PATTERN = /^\d{8}T\d{9}Z$/u;
const UPDATE_ACTIVATION_ARGUMENT_PATTERN = /^(?:type=update&release=(\d{8}T\d{9}Z))$/u;
const DNS_NAMESPACE = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
const MAX_APP_USER_MODEL_ID_BYTES = 512;
const MAX_ACTIVATION_ARGUMENT_BYTES = 256;
export const MAX_NOTIFICATION_ACTIVATIONS = 512;
export const MAX_UPDATE_ACTIVATIONS = 128;
export const MAX_PENDING_NOTIFICATION_ACTIVATIONS = 32;
export const MAX_PENDING_UPDATE_ACTIVATIONS = 32;
export const MAX_NOTIFICATION_FAILURE_LENGTH = 256;

export interface NotificationActivationScope {
  readonly projectId: string | null;
  readonly userId: string | null;
}

export interface NotificationActivationRoute {
  readonly projectId: string;
  readonly userId: string;
}

export interface WindowsNotificationActivationDetails {
  readonly type: string;
  readonly arguments: string;
}

export type WindowsNotificationCloseReason =
  "userCanceled" | "applicationHidden" | "timedOut" | undefined;

export function shouldRetainClosedScopedNotification(
  platform: NodeJS.Platform,
  reason: WindowsNotificationCloseReason,
): boolean {
  return (
    platform === "win32" &&
    (reason === undefined ||
      reason === "userCanceled" ||
      reason === "applicationHidden" ||
      reason === "timedOut")
  );
}

export function boundedNotificationFailure(value: unknown, fallback: string): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : fallback;
  const normalized = raw
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (normalized.length === 0 ? fallback : normalized).slice(
    0,
    MAX_NOTIFICATION_FAILURE_LENGTH,
  );
}

function normalizeUuid(value: string): string | null {
  return UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function formatClsid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex").toUpperCase();
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}}`;
}

/**
 * Derive a stable, per-AUMID toast activator CLSID with UUIDv5. The standard
 * DNS namespace plus the already unique AUMID prevents preview instances from
 * sharing one COM activation identity.
 */
export function deriveToastActivatorClsid(appUserModelId: string): string {
  if (
    appUserModelId.length === 0 ||
    Buffer.byteLength(appUserModelId, "utf8") > MAX_APP_USER_MODEL_ID_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(appUserModelId)
  ) {
    throw new Error("APP_USER_MODEL_ID_INVALID_FOR_TOAST_ACTIVATOR");
  }
  const digest = createHash("sha1")
    .update(DNS_NAMESPACE)
    .update(`${appUserModelId}.toast-activator`, "utf8")
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return formatClsid(bytes);
}

function xmlText(value: string): string {
  let valid = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
    ) {
      valid += character;
    } else {
      valid += " ";
    }
  }
  return valid.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

export function buildNotificationActivationArguments(notificationId: string): string {
  const normalized = normalizeUuid(notificationId);
  if (normalized === null) throw new Error("NOTIFICATION_ACTIVATION_ID_INVALID");
  return `type=click&tag=${normalized}`;
}

export function buildWindowsNotificationToastXml(input: {
  readonly notificationId: string;
  readonly title: string;
  readonly body: string;
}): string {
  const activationArguments = buildNotificationActivationArguments(input.notificationId);
  return [
    `<toast launch="${xmlText(activationArguments)}">`,
    '<visual><binding template="ToastGeneric">',
    `<text>${xmlText(input.title)}</text>`,
    `<text>${xmlText(input.body)}</text>`,
    "</binding></visual>",
    "</toast>",
  ].join("");
}

export function normalizeUpdateReleaseId(value: unknown): string | null {
  return typeof value === "string" && UPDATE_RELEASE_ID_PATTERN.test(value) ? value : null;
}

export function buildUpdateNotificationId(releaseId: string): string {
  const normalized = normalizeUpdateReleaseId(releaseId);
  if (normalized === null) throw new Error("UPDATE_NOTIFICATION_RELEASE_ID_INVALID");
  return `qa-hub-update-${normalized}`;
}

export function buildUpdateActivationArguments(releaseId: string): string {
  const normalized = normalizeUpdateReleaseId(releaseId);
  if (normalized === null) throw new Error("UPDATE_NOTIFICATION_RELEASE_ID_INVALID");
  return `type=update&release=${normalized}`;
}

export function buildWindowsUpdateNotificationToastXml(input: {
  readonly releaseId: string;
  readonly title: string;
  readonly body: string;
}): string {
  const activationArguments = buildUpdateActivationArguments(input.releaseId);
  return [
    `<toast launch="${xmlText(activationArguments)}">`,
    '<visual><binding template="ToastGeneric">',
    `<text>${xmlText(input.title)}</text>`,
    `<text>${xmlText(input.body)}</text>`,
    "</binding></visual>",
    "</toast>",
  ].join("");
}

export function parseNotificationActivationArguments(argumentsValue: unknown): string | null {
  if (
    typeof argumentsValue !== "string" ||
    Buffer.byteLength(argumentsValue, "utf8") > MAX_ACTIVATION_ARGUMENT_BYTES
  ) {
    return null;
  }
  const match = ACTIVATION_ARGUMENT_PATTERN.exec(argumentsValue);
  const notificationId = match?.[1] ?? match?.[2];
  return notificationId === undefined ? null : normalizeUuid(notificationId);
}

export function parseWindowsNotificationActivation(details: unknown): string | null {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return null;
  const record = details as Record<string, unknown>;
  if (record["type"] !== "click") return null;
  return parseNotificationActivationArguments(record["arguments"]);
}

export function parseWindowsUpdateNotificationActivation(details: unknown): string | null {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return null;
  const record = details as Record<string, unknown>;
  const argumentsValue = record["arguments"];
  if (
    record["type"] !== "click" ||
    typeof argumentsValue !== "string" ||
    Buffer.byteLength(argumentsValue, "utf8") > MAX_ACTIVATION_ARGUMENT_BYTES
  ) {
    return null;
  }
  return normalizeUpdateReleaseId(UPDATE_ACTIVATION_ARGUMENT_PATTERN.exec(argumentsValue)?.[1]);
}

export function notificationRouteMatchesScope(
  route: NotificationActivationRoute,
  scope: NotificationActivationScope,
): boolean {
  const routeProjectId = normalizeUuid(route.projectId);
  const routeUserId = normalizeUuid(route.userId);
  const scopeProjectId = scope.projectId === null ? null : normalizeUuid(scope.projectId);
  const scopeUserId = scope.userId === null ? null : normalizeUuid(scope.userId);
  return (
    routeProjectId !== null &&
    routeUserId !== null &&
    scopeProjectId !== null &&
    scopeUserId !== null &&
    routeProjectId === scopeProjectId &&
    routeUserId === scopeUserId
  );
}

export class PendingNotificationActivationQueue {
  private readonly pending = new Set<string>();

  constructor(private readonly maxSize = MAX_PENDING_NOTIFICATION_ACTIVATIONS) {
    if (!Number.isSafeInteger(maxSize) || maxSize < 1) {
      throw new Error("PENDING_NOTIFICATION_ACTIVATION_QUEUE_SIZE_INVALID");
    }
  }

  enqueue(notificationId: string): Readonly<{ accepted: boolean; evicted: string | null }> {
    const normalized = normalizeUuid(notificationId);
    if (normalized === null || this.pending.has(normalized)) {
      return Object.freeze({ accepted: false, evicted: null });
    }
    this.pending.add(normalized);
    let evicted: string | null = null;
    while (this.pending.size > this.maxSize) {
      const oldest = this.pending.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
      evicted = oldest;
    }
    return Object.freeze({ accepted: true, evicted });
  }

  drain(): readonly string[] {
    const notificationIds = Object.freeze([...this.pending]);
    this.pending.clear();
    return notificationIds;
  }
}

export class NotificationActivationGuard {
  private readonly claimed = new Set<string>();

  constructor(private readonly maxSize = MAX_NOTIFICATION_ACTIVATIONS) {
    if (!Number.isSafeInteger(maxSize) || maxSize < 1) {
      throw new Error("NOTIFICATION_ACTIVATION_GUARD_SIZE_INVALID");
    }
  }

  claim(notificationId: string): boolean {
    const normalized = normalizeUuid(notificationId);
    if (normalized === null || this.claimed.has(normalized)) return false;
    this.claimed.add(normalized);
    while (this.claimed.size > this.maxSize) {
      const oldest = this.claimed.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.claimed.delete(oldest);
    }
    return true;
  }
}

export class UpdateActivationGuard {
  private readonly claimed = new Set<string>();

  constructor(private readonly maxSize = MAX_UPDATE_ACTIVATIONS) {
    if (!Number.isSafeInteger(maxSize) || maxSize < 1) {
      throw new Error("UPDATE_ACTIVATION_GUARD_SIZE_INVALID");
    }
  }

  claim(releaseId: string): boolean {
    const normalized = normalizeUpdateReleaseId(releaseId);
    if (normalized === null || this.claimed.has(normalized)) return false;
    this.claimed.add(normalized);
    while (this.claimed.size > this.maxSize) {
      const oldest = this.claimed.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.claimed.delete(oldest);
    }
    return true;
  }

  release(releaseId: string): boolean {
    const normalized = normalizeUpdateReleaseId(releaseId);
    return normalized !== null && this.claimed.delete(normalized);
  }
}
