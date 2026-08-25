export const MOBILE_PROJECT_COLLECTION_PATH = "/api/v1/projects" as const;
export const MOBILE_PROJECT_MEMBERS_PATH = "/api/v1/projects/:projectId/members" as const;
export const MOBILE_PROJECT_MODULES_PATH = "/api/v1/projects/:projectId/modules" as const;

export type MobileProjectRole =
  | "viewer"
  | "reporter"
  | "developer"
  | "verifier"
  | "triager"
  | "release_manager"
  | "project_admin";

export interface MobileVisibleProject {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly active: true;
  readonly roles: readonly MobileProjectRole[];
}

export interface MobileVisibleProjectList {
  readonly snapshotSequence: number;
  readonly items: readonly MobileVisibleProject[];
  readonly nextCursor: null;
}

export interface MobileProjectMember {
  readonly userId: string;
  readonly projectId: string;
  readonly displayName: string;
  readonly roles: readonly MobileProjectRole[];
  readonly active: true;
}

export interface MobileProjectMemberList {
  readonly projectId: string;
  readonly snapshotSequence: number;
  readonly items: readonly MobileProjectMember[];
  readonly nextCursor: null;
}

export interface MobileProjectModule {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly active: boolean;
}

export interface MobileProjectModuleList {
  readonly projectId: string;
  readonly items: readonly MobileProjectModule[];
}

export interface MobileProjectDirectoryStore {
  readonly listProjects: (query: {
    readonly actorId: string;
    readonly limit: number;
  }) => MobileVisibleProjectList | Promise<MobileVisibleProjectList>;
  readonly listMembers: (query: {
    readonly actorId: string;
    readonly projectId: string;
    readonly limit: number;
  }) => MobileProjectMemberList | Promise<MobileProjectMemberList>;
  readonly listModules: (query: {
    readonly actorId: string;
    readonly projectId: string;
  }) => MobileProjectModuleList | Promise<MobileProjectModuleList>;
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`unexpected property: ${key}`);
  }
}

function queryString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (Array.isArray(candidate)) {
    if (candidate.length !== 1 || typeof candidate[0] !== "string") {
      throw new TypeError(`${key} must occur at most once`);
    }
    return candidate[0];
  }
  if (typeof candidate !== "string") throw new TypeError(`${key} must be a string`);
  return candidate;
}

export function parseMobileProjectDirectoryListQuery(value: unknown): { readonly limit: number } {
  const query = requireRecord(value, "project directory query");
  requireOnlyKeys(query, new Set(["cursor", "limit"]));
  if (queryString(query, "cursor") !== undefined) {
    throw new TypeError("cursor is not available in the first project directory slice");
  }
  const rawLimit = queryString(query, "limit");
  if (rawLimit === undefined) return { limit: 50 };
  if (!/^[1-9][0-9]{0,2}$/u.test(rawLimit)) throw new TypeError("limit is invalid");
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit > 100) throw new TypeError("limit is invalid");
  return { limit };
}

export function requireMobileProjectUuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${label} must be a UUID`);
  return value.toLowerCase();
}
