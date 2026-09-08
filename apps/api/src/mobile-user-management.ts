import type { ManagedUserMutationResult, MobileProjectRole } from "@relay-qa-hub/storage";

export const MOBILE_MANAGED_USER_COLLECTION_PATH = "/api/v1/projects/:projectId/users" as const;
export const MOBILE_MANAGED_USER_ITEM_PATH = "/api/v1/projects/:projectId/users/:userId" as const;
export const MOBILE_USER_IDENTITY_LINK_PATH =
  "/api/v1/projects/:projectId/users/:userId/identity-link" as const;

export interface ManagedProjectUser {
  readonly userId: string;
  readonly displayName: string;
  readonly status: "active" | "disabled";
  readonly membershipStatus: "active" | "revoked";
  readonly membershipVersion: number;
  readonly roles: readonly MobileProjectRole[];
  readonly identity: "employee";
  readonly linkedToUserId: string | null;
  readonly linkedToDisplayName: string | null;
  readonly linkedUserCount: number;
  readonly taskCount: number;
  readonly activeSessionCount: number;
  readonly protected: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ManagedProjectUserList {
  readonly projectId: string;
  readonly items: readonly ManagedProjectUser[];
}

export interface MobileUserManagementStore {
  readonly listUsers: (query: {
    readonly actorId: string;
    readonly projectId: string;
    readonly limit: number;
  }) => ManagedProjectUserList | Promise<ManagedProjectUserList>;
  readonly linkUser: (command: {
    readonly actorId: string;
    readonly projectId: string;
    readonly userId: string;
    readonly canonicalUserId: string;
  }) => ManagedUserMutationResult | Promise<ManagedUserMutationResult>;
  readonly unlinkUser: (command: {
    readonly actorId: string;
    readonly projectId: string;
    readonly userId: string;
  }) => ManagedUserMutationResult | Promise<ManagedUserMutationResult>;
  readonly disableUser: (command: {
    readonly actorId: string;
    readonly projectId: string;
    readonly userId: string;
  }) => ManagedUserMutationResult | Promise<ManagedUserMutationResult>;
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

export function parseManagedUserListQuery(value: unknown): { readonly limit: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("managed user query must be an object");
  }
  const query = value as Record<string, unknown>;
  for (const key of Object.keys(query)) {
    if (key !== "limit") throw new TypeError(`unexpected property: ${key}`);
  }
  const rawLimit = query["limit"];
  if (rawLimit === undefined) return { limit: 200 };
  if (typeof rawLimit !== "string" || !/^[1-9][0-9]{0,2}$/u.test(rawLimit)) {
    throw new TypeError("limit is invalid");
  }
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit > 500) throw new TypeError("limit is invalid");
  return { limit };
}

export function parseIdentityLinkRequest(value: unknown): { readonly canonicalUserId: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("identity link request must be an object");
  }
  const request = value as Record<string, unknown>;
  if (Object.keys(request).length !== 1 || typeof request["canonicalUserId"] !== "string") {
    throw new TypeError("identity link request must contain only canonicalUserId");
  }
  const canonicalUserId = request["canonicalUserId"];
  if (!UUID_PATTERN.test(canonicalUserId)) {
    throw new TypeError("canonicalUserId must be a UUID");
  }
  return { canonicalUserId: canonicalUserId.toLowerCase() };
}
