const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ExactNotificationScope {
  readonly projectId: string;
  readonly userId: string;
}

export type NotificationPrincipalIdentity = "employee" | "gm";

export interface BearerNotificationPrincipal {
  readonly displayName: string;
  readonly userId: string;
  readonly projectId?: string;
  readonly isGm: boolean;
}

export type NotificationScopeMissingReason =
  "NOTIFICATION_PROJECT_SCOPE_MISSING" | "NOTIFICATION_USER_SCOPE_MISSING";

interface NotificationPrincipalReader {
  readonly json: (pathname: string) => Promise<unknown>;
}

interface NotificationPrincipalSession {
  clearLoginName(): void;
  rememberPrincipal(value: unknown): void;
}

export function normalizeNotificationUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

export function isNotificationPrincipalIdentity(
  value: unknown,
): value is NotificationPrincipalIdentity {
  return value === "employee" || value === "gm";
}

export function exactNotificationScope(
  projectIdValue: unknown,
  userIdValue: unknown,
  identityValue: unknown,
): ExactNotificationScope | null {
  const projectId = normalizeNotificationUuid(projectIdValue);
  const userId = normalizeNotificationUuid(userIdValue);
  return projectId === null || userId === null || !isNotificationPrincipalIdentity(identityValue)
    ? null
    : { projectId, userId };
}

export function notificationScopeMissingReason(
  projectIdValue: unknown,
  userIdValue: unknown,
  identityValue: unknown,
): NotificationScopeMissingReason | null {
  if (normalizeNotificationUuid(projectIdValue) === null)
    return "NOTIFICATION_PROJECT_SCOPE_MISSING";
  if (
    normalizeNotificationUuid(userIdValue) === null ||
    !isNotificationPrincipalIdentity(identityValue)
  ) {
    return "NOTIFICATION_USER_SCOPE_MISSING";
  }
  return null;
}

export function parseBearerNotificationPrincipal(value: unknown): BearerNotificationPrincipal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("NOTIFICATION_PRINCIPAL_INVALID");
  }
  const record = value as Record<string, unknown>;
  const displayName = record["displayName"];
  const userId = normalizeNotificationUuid(record["userId"]);
  const isGm = record["isGm"];
  const projectId =
    record["projectId"] === undefined ? null : normalizeNotificationUuid(record["projectId"]);
  if (
    typeof displayName !== "string" ||
    displayName.trim().length === 0 ||
    displayName.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(displayName) ||
    userId === null ||
    typeof isGm !== "boolean" ||
    (record["projectId"] !== undefined && projectId === null) ||
    (!isGm && projectId === null)
  ) {
    throw new Error("NOTIFICATION_PRINCIPAL_INVALID");
  }
  return {
    displayName: displayName.trim(),
    userId,
    ...(projectId === null ? {} : { projectId }),
    isGm,
  };
}

export async function bootstrapBearerNotificationScope(
  api: NotificationPrincipalReader,
  session: NotificationPrincipalSession,
  persist: () => Promise<void>,
): Promise<ExactNotificationScope | null> {
  // A persisted identity can belong to a different static token. Remove it from
  // the live session before the token-authenticated read, and publish no scope
  // unless that exact principal is validated and durably committed.
  session.clearLoginName();
  try {
    const principal = parseBearerNotificationPrincipal(await api.json("/api/v1/auth/me"));
    session.rememberPrincipal(principal);
    await persist();
    return exactNotificationScope(
      principal.projectId,
      principal.userId,
      principal.isGm ? "gm" : "employee",
    );
  } catch (error) {
    session.clearLoginName();
    throw error;
  }
}
