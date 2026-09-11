import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { decodeScopedListCursor, encodeScopedListCursor } from "./scoped-list-cursor.js";
import { canonicalProjectUserId } from "./project-identity-projection.js";

export const PROJECT_COMPONENT_KEYS = [
  "build",
  "build_upload.single",
  "upload.incremental",
  "relay.production",
  "qingyu.sync",
] as const;
export type ProjectComponentKey = (typeof PROJECT_COMPONENT_KEYS)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CAPABILITIES = [
  "viewer",
  "reporter",
  "developer",
  "verifier",
  "triager",
  "release_manager",
  "project_admin",
];
const NAMES: Record<ProjectComponentKey, string> = {
  build: "打包",
  "build_upload.single": "单次打包上传",
  "upload.incremental": "增量上传",
  "relay.production": "Relay AI 制作",
  "qingyu.sync": "第三方订单同步",
};
export interface ProjectRecord {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly active: boolean;
  readonly version: number;
}
export interface ProjectLogoRecord {
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
  readonly sha256: string;
  readonly bytes: Uint8Array;
}
export interface ProjectInitialMemberInput {
  readonly userId: string;
  readonly nameKey: string;
  readonly displayName: string;
  readonly email: string;
}
export interface ProjectOnboardingRecord extends ProjectRecord {
  readonly initializationStatus: "pending" | "ready";
  readonly joinName: string | null;
  readonly joinCodeCiphertext: string | null;
  readonly joinCodeVersion: number;
  readonly initializationTokenStatus: "absent" | "issued" | "used" | "revoked";
  readonly initializationTokenCiphertext: string | null;
  readonly initializationIssuedAt: string | null;
  readonly initializationUsedAt: string | null;
  readonly logo: ProjectLogoRecord | null;
  readonly onboardingVersion: number;
}
export interface ProjectComponentRecord {
  readonly key: ProjectComponentKey;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly status: "disabled" | "needs_configuration" | "ready";
  readonly version: number;
  readonly config: Readonly<Record<string, unknown>>;
  readonly updatedBy: string | null;
  readonly updatedAt: string | null;
}
export interface ProjectComponentList {
  readonly projectId: string;
  readonly items: readonly ProjectComponentRecord[];
}
export interface ProjectPrincipal {
  readonly accountId: string;
  readonly actorId: string;
  readonly isGm?: boolean;
}
export interface ProjectManagementInput extends ProjectPrincipal {
  readonly operation:
    | "entry"
    | "list"
    | "create"
    | "createOnboarding"
    | "update"
    | "login"
    | "joinByCode"
    | "loginIdentities"
    | "onboardingAdmin"
    | "inspectInitialization"
    | "initializeProject"
    | "resetJoinCode"
    | "rotateInitializationToken"
    | "revokeInitializationToken"
    | "projectLogo"
    | "membership"
    | "authorize"
    | "components"
    | "setComponent"
    | "audit"
    | "recordProject"
    | "comments";
  readonly projectId?: string;
  readonly key?: string;
  readonly name?: string;
  readonly nameKey?: string;
  readonly active?: boolean;
  readonly expectedVersion?: number;
  readonly userId?: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly memberNameKey?: string;
  readonly joinCodeDigest?: string;
  readonly joinCodeCiphertext?: string;
  readonly initializationTokenDigest?: string;
  readonly initializationTokenCiphertext?: string;
  readonly submissionDigest?: string;
  readonly initialMembers?: readonly ProjectInitialMemberInput[];
  readonly logo?: ProjectLogoRecord | null;
  readonly now?: string;
  readonly componentKey?: ProjectComponentKey;
  readonly enabled?: boolean;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly includePrivateConfig?: boolean;
  readonly recordType?:
    | "bug"
    | "attachment"
    | "capture"
    | "build"
    | "verification"
    | "repair"
    | "upload"
    | "notification";
  readonly recordId?: string;
  readonly bugId?: string;
  readonly limit?: number;
  readonly cursor?: string;
}
export class ProjectManagementError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectManagementError";
  }
}
function fail(code: string, message: string): never {
  throw new ProjectManagementError(code, message);
}
function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value))
    fail("INVALID_REQUEST", `${label} must be a UUID`);
  return value.toLowerCase();
}
function now(input: ProjectManagementInput): string {
  if (!input.now || input.now.length < 20 || !Number.isFinite(Date.parse(input.now)))
    fail("INVALID_REQUEST", "now must be an ISO timestamp");
  return input.now;
}
function requireGm(input: ProjectManagementInput): void {
  if (!input.isGm) fail("FORBIDDEN", "GM login is required");
}
function requireVersion(actual: number, expected: number | undefined): void {
  if (!Number.isSafeInteger(expected) || expected !== actual)
    fail("VERSION_CONFLICT", "refresh the current version before saving");
}
function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value))
    fail("INVALID_REQUEST", `${label} must be a lowercase SHA-256 digest`);
  return value;
}
function nameKey(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200)
    fail("INVALID_REQUEST", `${label} is invalid`);
  return value;
}
function onboardingRow(
  database: DatabaseSync,
  accountId: string,
  projectId: string,
): ProjectOnboardingRecord {
  const row = database
    .prepare(
      `SELECT project.id, project.project_key AS key, project.name, project.status, project.version,
       onboarding.initialization_status, onboarding.join_name, onboarding.join_code_ciphertext,
       onboarding.join_code_version, onboarding.initialization_token_status,
       onboarding.initialization_token_ciphertext,
       onboarding.initialization_issued_at, onboarding.initialization_used_at,
       onboarding.logo_media_type, onboarding.logo_sha256, onboarding.logo_bytes,
       onboarding.version AS onboarding_version
       FROM projects AS project JOIN project_onboarding AS onboarding
         ON onboarding.account_id = project.account_id AND onboarding.project_id = project.id
       WHERE project.account_id = ? AND project.id = ?`,
    )
    .get(accountId, projectId) as
    | {
        id: string;
        key: string;
        name: string;
        status: string;
        version: number;
        initialization_status: "pending" | "ready";
        join_name: string | null;
        join_code_ciphertext: string | null;
        join_code_version: number;
        initialization_token_status: "absent" | "issued" | "used" | "revoked";
        initialization_token_ciphertext: string | null;
        initialization_issued_at: string | null;
        initialization_used_at: string | null;
        logo_media_type: ProjectLogoRecord["mediaType"] | null;
        logo_sha256: string | null;
        logo_bytes: Uint8Array | null;
        onboarding_version: number;
      }
    | undefined;
  if (!row) fail("NOT_FOUND", "project onboarding was not found");
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    active: row.status === "active",
    version: row.version,
    initializationStatus: row.initialization_status,
    joinName: row.join_name,
    joinCodeCiphertext: row.join_code_ciphertext,
    joinCodeVersion: row.join_code_version,
    initializationTokenStatus: row.initialization_token_status,
    initializationTokenCiphertext: row.initialization_token_ciphertext,
    initializationIssuedAt: row.initialization_issued_at,
    initializationUsedAt: row.initialization_used_at,
    logo:
      row.logo_media_type && row.logo_sha256 && row.logo_bytes
        ? {
            mediaType: row.logo_media_type,
            sha256: row.logo_sha256,
            bytes: row.logo_bytes,
          }
        : null,
    onboardingVersion: row.onboarding_version,
  };
}
function validateLogo(value: ProjectLogoRecord | null | undefined): ProjectLogoRecord | null {
  if (value === undefined || value === null) return null;
  if (!["image/png", "image/jpeg", "image/webp"].includes(value.mediaType))
    fail("INVALID_REQUEST", "logo media type is invalid");
  digest(value.sha256, "logo sha256");
  if (
    !(value.bytes instanceof Uint8Array) ||
    value.bytes.byteLength < 1 ||
    value.bytes.byteLength > 524288
  )
    fail("INVALID_REQUEST", "logo must contain 1 through 524288 bytes");
  return value;
}
function ensureNamedProjectMember(
  database: DatabaseSync,
  input: ProjectManagementInput,
  projectId: string,
  member: ProjectInitialMemberInput,
  timestamp: string,
): { userId: string; displayName: string; membershipId: string; created: boolean } {
  const normalized = nameKey(member.nameKey, "member name key");
  const requestedUserId = uuid(member.userId, "userId");
  if (!member.displayName?.trim() || member.displayName.length > 200 || !member.email?.trim())
    fail("INVALID_REQUEST", "member identity is invalid");
  const mapped = database
    .prepare(
      `SELECT names.user_id, names.display_name, users.status AS user_status,
       memberships.id AS membership_id, memberships.status AS membership_status
       FROM project_member_names AS names
       JOIN users ON users.account_id = names.account_id AND users.id = names.user_id
       JOIN memberships ON memberships.account_id = names.account_id
         AND memberships.project_id = names.project_id AND memberships.user_id = names.user_id
       WHERE names.account_id = ? AND names.project_id = ? AND names.name_key = ?`,
    )
    .get(input.accountId, projectId, normalized) as
    | {
        user_id: string;
        display_name: string;
        user_status: string;
        membership_id: string;
        membership_status: string;
      }
    | undefined;
  if (mapped) {
    if (mapped.user_status !== "active") fail("AUTHENTICATION_FAILED", "identity is disabled");
    if (mapped.membership_status !== "active")
      fail("PROJECT_MEMBERSHIP_DISABLED", "项目成员已停用，请联系项目人员恢复");
    return {
      userId: mapped.user_id,
      displayName: mapped.display_name,
      membershipId: mapped.membership_id,
      created: false,
    };
  }
  database
    .prepare(
      "INSERT OR IGNORE INTO users(id, account_id, email, display_name, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)",
    )
    .run(
      requestedUserId,
      input.accountId,
      member.email.trim(),
      member.displayName.trim(),
      timestamp,
      timestamp,
    );
  const user = database
    .prepare("SELECT id, display_name, status FROM users WHERE account_id = ? AND id = ?")
    .get(input.accountId, requestedUserId) as
    { id: string; display_name: string; status: string } | undefined;
  if (!user || user.status !== "active") fail("AUTHENTICATION_FAILED", "identity is disabled");
  const membershipId = projectMembershipId(projectId, requestedUserId);
  const priorMembership = database
    .prepare(
      "SELECT id, status FROM memberships WHERE account_id = ? AND project_id = ? AND user_id = ?",
    )
    .get(input.accountId, projectId, requestedUserId) as { id: string; status: string } | undefined;
  if (priorMembership?.status === "revoked")
    fail("PROJECT_MEMBERSHIP_DISABLED", "项目成员已停用，请联系项目人员恢复");
  if (!priorMembership)
    database
      .prepare(
        "INSERT INTO memberships(id, account_id, project_id, user_id, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)",
      )
      .run(membershipId, input.accountId, projectId, requestedUserId, timestamp, timestamp);
  grantCapabilities(
    database,
    input.accountId,
    projectId,
    priorMembership?.id ?? membershipId,
    timestamp,
  );
  database
    .prepare(
      "INSERT INTO project_member_names(account_id, project_id, name_key, display_name, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      input.accountId,
      projectId,
      normalized,
      member.displayName.trim(),
      requestedUserId,
      timestamp,
      timestamp,
    );
  return {
    userId: requestedUserId,
    displayName: user.display_name,
    membershipId: priorMembership?.id ?? membershipId,
    created: !priorMembership,
  };
}
function project(database: DatabaseSync, input: ProjectManagementInput): ProjectRecord {
  const id = input.projectId;
  if (!id && !input.key) fail("PROJECT_REQUIRED", "请选择项目");
  const row = database
    .prepare(
      "SELECT id, project_key AS key, name, status, version FROM projects WHERE account_id = ? AND (id = ? OR (? IS NOT NULL AND project_key = ?))",
    )
    .get(input.accountId, id ?? null, id ? null : (input.key ?? null), input.key ?? null) as
    { id: string; key: string; name: string; status: string; version: number } | undefined;
  if (!row) fail("NOT_FOUND", "project was not found");
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    active: row.status === "active",
    version: row.version,
  };
}
export function requireProjectAccess(
  database: DatabaseSync,
  input: ProjectPrincipal,
  projectId: string,
): void {
  const row = database
    .prepare(
      `SELECT 1 FROM projects AS project JOIN accounts AS account ON account.id = project.account_id AND account.status = 'active'
    JOIN users AS actor ON actor.account_id = account.id AND actor.id = ? AND actor.status = 'active'
    WHERE project.account_id = ? AND project.id = ? AND project.status = 'active'
    AND (? = 1 OR EXISTS (SELECT 1 FROM memberships WHERE account_id = project.account_id AND project_id = project.id AND user_id = actor.id AND status = 'active'))`,
    )
    .get(input.actorId, input.accountId, projectId, input.isGm ? 1 : 0);
  if (!row) fail("PROJECT_NOT_ACCESSIBLE", "project is unavailable or membership is inactive");
}
export function projectMembershipId(projectId: string, userId: string): string {
  const digest = createHash("sha256")
    .update(`qa-hub-project-membership:${projectId}:${userId}`)
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
function grantCapabilities(
  database: DatabaseSync,
  accountId: string,
  projectId: string,
  membershipId: string,
  timestamp: string,
): void {
  const statement = database.prepare(
    "INSERT OR IGNORE INTO membership_roles(account_id, project_id, membership_id, role, granted_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const role of CAPABILITIES)
    statement.run(accountId, projectId, membershipId, role, timestamp);
}
function audit(
  database: DatabaseSync,
  input: ProjectManagementInput,
  projectId: string,
  action: string,
  subjectId: string,
  summary: unknown,
): void {
  database
    .prepare(
      "INSERT INTO project_management_events(id, account_id, project_id, actor_id, action, subject_id, summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      randomUUID(),
      input.accountId,
      projectId,
      input.actorId,
      action,
      subjectId,
      JSON.stringify(summary),
      now(input),
    );
}
// This is an allowlist, deliberately not a recursive token/password denylist.
// New server configuration keys stay private until explicitly reviewed here.
function publicConfig(
  config: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const safe: Record<string, unknown> = {};
  for (const key of [
    "job",
    "jobName",
    "projectKey",
    "externalProjectId",
    "channel",
    "platform",
    "description",
    "targetLabel",
    "buildPreset",
  ]) {
    const value = config[key];
    if (typeof value === "string" && value.length <= 500) safe[key] = value;
  }
  const presets = config["presets"];
  if (presets && typeof presets === "object" && !Array.isArray(presets))
    safe["presetOptions"] = Object.keys(presets).filter((key) =>
      /^[A-Za-z0-9_.-]{1,80}$/u.test(key),
    );
  const defaults = config["defaults"];
  if (defaults && typeof defaults === "object" && !Array.isArray(defaults)) {
    const values = defaults as Record<string, unknown>;
    const filtered: Record<string, unknown> = {};
    for (const key of ["productId", "channelId", "belongName", "mode"])
      if (typeof values[key] === "string" && String(values[key]).length <= 500)
        filtered[key] = values[key];
    if (Number.isSafeInteger(values["testerId"]) && Number(values["testerId"]) > 0)
      filtered["testerId"] = values["testerId"];
    safe["defaults"] = filtered;
  }
  return safe;
}
function configured(key: ProjectComponentKey, config: Readonly<Record<string, unknown>>): boolean {
  const has = (field: string) =>
    typeof config[field] === "string" && String(config[field]).trim().length > 0;
  const object = (field: string) =>
    config[field] !== null && typeof config[field] === "object" && !Array.isArray(config[field]);
  if (key === "build")
    return (
      has("baseUrl") &&
      (has("job") || has("jobName")) &&
      has("downloadOrigin") &&
      has("zipPath") &&
      has("artifactUrlTemplate") &&
      has("credentialRef") &&
      object("presets") &&
      Object.keys(config["presets"] as object).length > 0
    );
  if (key === "upload.incremental")
    return (
      ["credentialRef", "apiBase", "loginBase", "sourceUrl"].every(has) &&
      ["targetPrefix", "testDirectoryPrefix", "releaseDirectoryPrefix"].every((field) => {
        if (!has(field)) return false;
        const value = String(config[field]);
        return (
          !value.startsWith("/") &&
          value.endsWith("/") &&
          !value.includes("..") &&
          !value.includes("\\") &&
          !value.includes(":")
        );
      }) &&
      object("defaults") &&
      ["productId", "channelId", "belongName"].every((field) => {
        const value = (config["defaults"] as Record<string, unknown>)[field];
        return typeof value === "string" && value.trim().length > 0;
      }) &&
      Number.isSafeInteger((config["defaults"] as Record<string, unknown>)["testerId"]) &&
      Number((config["defaults"] as Record<string, unknown>)["testerId"]) > 0
    );
  if (key === "relay.production")
    return (
      has("baseUrl") && has("externalProjectId") && has("relayInstanceId") && has("credentialRef")
    );
  if (key === "qingyu.sync")
    return has("baseUrl") && has("externalProjectId") && has("credentialRef");
  return has("buildPreset");
}
function components(
  database: DatabaseSync,
  input: ProjectManagementInput,
  projectId: string,
): ProjectComponentList {
  const rows = database
    .prepare(
      "SELECT component_key, enabled, config_json, version, updated_by, updated_at FROM project_components WHERE account_id = ? AND project_id = ?",
    )
    .all(input.accountId, projectId) as {
    component_key: ProjectComponentKey;
    enabled: number;
    config_json: string;
    version: number;
    updated_by: string;
    updated_at: string;
  }[];
  return {
    projectId,
    items: PROJECT_COMPONENT_KEYS.map((key) => {
      const row = rows.find((item) => item.component_key === key);
      const config = row ? (JSON.parse(row.config_json) as Record<string, unknown>) : {};
      const enabled = row?.enabled === 1;
      return {
        key,
        displayName: NAMES[key],
        enabled,
        status: !enabled ? "disabled" : configured(key, config) ? "ready" : "needs_configuration",
        version: row?.version ?? 0,
        config: input.isGm && input.includePrivateConfig ? config : publicConfig(config),
        updatedBy: row?.updated_by ?? null,
        updatedAt: row?.updated_at ?? null,
      };
    }),
  };
}
export function projectManagement(database: DatabaseSync, input: ProjectManagementInput): unknown {
  uuid(input.accountId, "accountId");
  if (input.operation === "createOnboarding") {
    requireGm(input);
    const projectId = uuid(input.projectId, "projectId");
    const timestamp = now(input);
    const codeDigest = digest(input.joinCodeDigest, "join code digest");
    const tokenDigest = digest(input.initializationTokenDigest, "initialization token digest");
    if (
      !input.key ||
      !/^[A-Z][A-Z0-9]{1,15}$/u.test(input.key) ||
      !input.name?.trim() ||
      input.name.length > 200 ||
      !input.joinCodeCiphertext ||
      input.joinCodeCiphertext.length > 500 ||
      !input.initializationTokenCiphertext ||
      input.initializationTokenCiphertext.length > 1000
    )
      fail("INVALID_REQUEST", "pending project details are invalid");
    if (
      database
        .prepare("SELECT 1 FROM projects WHERE account_id = ? AND (id = ? OR project_key = ?)")
        .get(input.accountId, projectId, input.key)
    )
      fail("VERSION_CONFLICT", "project ID or key already exists");
    database
      .prepare(
        "INSERT INTO projects(id, account_id, project_key, name, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)",
      )
      .run(projectId, input.accountId, input.key, input.name.trim(), timestamp, timestamp);
    const membershipId = projectMembershipId(projectId, input.actorId);
    database
      .prepare(
        "INSERT INTO memberships(id, account_id, project_id, user_id, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)",
      )
      .run(membershipId, input.accountId, projectId, input.actorId, timestamp, timestamp);
    grantCapabilities(database, input.accountId, projectId, membershipId, timestamp);
    database
      .prepare(
        `UPDATE project_onboarding SET join_code_digest = ?, join_code_ciphertext = ?,
          join_code_version = 1, initialization_token_digest = ?,
          initialization_token_ciphertext = ?, initialization_token_status = 'issued',
          initialization_issued_at = ?, updated_at = ?, version = version + 1
         WHERE account_id = ? AND project_id = ?`,
      )
      .run(
        codeDigest,
        input.joinCodeCiphertext,
        tokenDigest,
        input.initializationTokenCiphertext,
        timestamp,
        timestamp,
        input.accountId,
        projectId,
      );
    audit(database, input, projectId, "project.onboarding_created", projectId, {
      key: input.key,
      initializationStatus: "pending",
    });
    return onboardingRow(database, input.accountId, projectId);
  }
  if (input.operation === "onboardingAdmin") {
    requireGm(input);
    uuid(input.actorId, "actorId");
    if (input.projectId)
      return onboardingRow(database, input.accountId, uuid(input.projectId, "projectId"));
    const rows = database
      .prepare(
        "SELECT project_id FROM project_onboarding WHERE account_id = ? ORDER BY created_at, project_id",
      )
      .all(input.accountId) as { project_id: string }[];
    return { items: rows.map((row) => onboardingRow(database, input.accountId, row.project_id)) };
  }
  if (input.operation === "inspectInitialization") {
    const tokenDigest = digest(input.initializationTokenDigest, "initialization token digest");
    const row = database
      .prepare(
        `SELECT project_id FROM project_onboarding
         WHERE account_id = ? AND initialization_token_digest = ?
           AND initialization_token_status = 'issued'`,
      )
      .get(input.accountId, tokenDigest) as { project_id: string } | undefined;
    if (!row) fail("INITIALIZATION_LINK_INVALID", "初始化链接无效或已撤销");
    return onboardingRow(database, input.accountId, row.project_id);
  }
  if (input.operation === "initializeProject") {
    const tokenDigest = digest(input.initializationTokenDigest, "initialization token digest");
    const requestDigest = digest(input.submissionDigest, "initialization submission digest");
    const timestamp = now(input);
    const token = database
      .prepare(
        `SELECT project_id, initialization_token_status, initialization_submission_digest
         FROM project_onboarding WHERE account_id = ? AND initialization_token_digest = ?`,
      )
      .get(input.accountId, tokenDigest) as
      | {
          project_id: string;
          initialization_token_status: "issued" | "used" | "revoked";
          initialization_submission_digest: string | null;
        }
      | undefined;
    if (!token || token.initialization_token_status === "revoked")
      fail("INITIALIZATION_LINK_INVALID", "初始化链接无效或已撤销");
    if (token.initialization_token_status === "used") {
      fail("INITIALIZATION_ALREADY_COMPLETED", "项目已经完成初始化");
    }
    const normalizedName = input.name?.trim();
    const normalizedNameKey = nameKey(input.nameKey, "project name key");
    if (!normalizedName || normalizedName.length > 200)
      fail("INVALID_REQUEST", "project name is invalid");
    if (
      database
        .prepare(
          "SELECT 1 FROM project_onboarding WHERE account_id = ? AND join_name_key = ? AND project_id <> ?",
        )
        .get(input.accountId, normalizedNameKey, token.project_id)
    )
      fail("PROJECT_NAME_CONFLICT", "项目名称已被使用，请联系 GM 处理");
    const members = input.initialMembers ?? [];
    if (
      members.length > 500 ||
      new Set(members.map((member) => member.nameKey)).size !== members.length
    )
      fail("INVALID_REQUEST", "initial members must be unique and no more than 500");
    const logo = validateLogo(input.logo);
    database
      .prepare(
        "UPDATE projects SET name = ?, updated_at = ?, version = version + 1 WHERE account_id = ? AND id = ?",
      )
      .run(normalizedName, timestamp, input.accountId, token.project_id);
    database
      .prepare(
        `UPDATE project_onboarding SET join_name = ?, join_name_key = ?,
          initialization_status = 'ready', initialization_token_status = 'used',
          initialization_submission_digest = ?, initialization_used_at = ?,
          initialization_revoked_at = NULL, logo_media_type = ?, logo_sha256 = ?, logo_bytes = ?,
          updated_at = ?, version = version + 1
         WHERE account_id = ? AND project_id = ?`,
      )
      .run(
        normalizedName,
        normalizedNameKey,
        requestDigest,
        timestamp,
        logo?.mediaType ?? null,
        logo?.sha256 ?? null,
        logo?.bytes ?? null,
        timestamp,
        input.accountId,
        token.project_id,
      );
    for (const member of members) {
      const ensured = ensureNamedProjectMember(
        database,
        input,
        token.project_id,
        member,
        timestamp,
      );
      if (ensured.created)
        audit(
          database,
          { ...input, actorId: input.actorId },
          token.project_id,
          "membership.initialized",
          ensured.userId,
          { displayName: ensured.displayName },
        );
    }
    audit(database, input, token.project_id, "project.initialized", token.project_id, {
      name: normalizedName,
      initialMemberCount: members.length,
      hasLogo: logo !== null,
    });
    return onboardingRow(database, input.accountId, token.project_id);
  }
  if (input.operation === "joinByCode") {
    const projectNameKey = nameKey(input.nameKey, "project name key");
    const codeDigest = digest(input.joinCodeDigest, "join code digest");
    const timestamp = now(input);
    const match = database
      .prepare(
        `SELECT onboarding.project_id FROM project_onboarding AS onboarding
         JOIN projects AS project ON project.account_id = onboarding.account_id
           AND project.id = onboarding.project_id AND project.status = 'active'
         WHERE onboarding.account_id = ? AND onboarding.join_name_key = ?
           AND onboarding.join_code_digest = ? AND onboarding.initialization_status = 'ready'`,
      )
      .get(input.accountId, projectNameKey, codeDigest) as { project_id: string } | undefined;
    if (!match) fail("AUTHENTICATION_FAILED", "项目名称或验证码不正确");
    const member = ensureNamedProjectMember(
      database,
      input,
      match.project_id,
      {
        userId: uuid(input.userId, "userId"),
        nameKey: nameKey(input.memberNameKey, "member name key"),
        displayName: input.displayName ?? "",
        email: input.email ?? "",
      },
      timestamp,
    );
    if (member.created)
      audit(
        database,
        { ...input, actorId: member.userId },
        match.project_id,
        "membership.joined_with_code",
        member.userId,
        { displayName: member.displayName },
      );
    return {
      userId: member.userId,
      displayName: member.displayName,
      projectId: match.project_id,
      projectName: onboardingRow(database, input.accountId, match.project_id).joinName,
    };
  }
  if (input.operation === "resetJoinCode") {
    requireGm(input);
    uuid(input.actorId, "actorId");
    const projectId = uuid(input.projectId, "projectId");
    const current = onboardingRow(database, input.accountId, projectId);
    const codeDigest = digest(input.joinCodeDigest, "join code digest");
    if (!input.joinCodeCiphertext || input.joinCodeCiphertext.length > 500)
      fail("INVALID_REQUEST", "join code ciphertext is invalid");
    database
      .prepare(
        `UPDATE project_onboarding SET join_code_digest = ?, join_code_ciphertext = ?,
         join_code_version = join_code_version + 1, updated_at = ?, version = version + 1
         WHERE account_id = ? AND project_id = ?`,
      )
      .run(codeDigest, input.joinCodeCiphertext, now(input), input.accountId, projectId);
    audit(database, input, projectId, "project.join_code_reset", projectId, {
      previousVersion: current.joinCodeVersion,
    });
    return onboardingRow(database, input.accountId, projectId);
  }
  if (input.operation === "rotateInitializationToken") {
    requireGm(input);
    uuid(input.actorId, "actorId");
    const projectId = uuid(input.projectId, "projectId");
    const current = onboardingRow(database, input.accountId, projectId);
    if (current.initializationStatus !== "pending")
      fail("INITIALIZATION_ALREADY_COMPLETED", "项目已经完成初始化");
    const tokenDigest = digest(input.initializationTokenDigest, "initialization token digest");
    if (!input.initializationTokenCiphertext || input.initializationTokenCiphertext.length > 1000)
      fail("INVALID_REQUEST", "initialization token ciphertext is invalid");
    const tokenCiphertext = input.initializationTokenCiphertext;
    const issuedAt = now(input);
    const codeDigest = input.joinCodeDigest
      ? digest(input.joinCodeDigest, "join code digest")
      : undefined;
    if ((codeDigest === undefined) !== (input.joinCodeCiphertext === undefined))
      fail("INVALID_REQUEST", "join code replacement must be complete");
    database
      .prepare(
        `UPDATE project_onboarding SET initialization_token_digest = ?,
          initialization_token_ciphertext = ?,
          initialization_token_status = 'issued', initialization_submission_digest = NULL,
          initialization_issued_at = ?, initialization_used_at = NULL,
          initialization_revoked_at = NULL,
          join_code_digest = COALESCE(?, join_code_digest),
          join_code_ciphertext = COALESCE(?, join_code_ciphertext),
          join_code_version = CASE WHEN ? IS NULL THEN join_code_version ELSE join_code_version + 1 END,
          updated_at = ?, version = version + 1
         WHERE account_id = ? AND project_id = ?`,
      )
      .run(
        tokenDigest,
        tokenCiphertext,
        issuedAt,
        codeDigest ?? null,
        input.joinCodeCiphertext ?? null,
        codeDigest ?? null,
        issuedAt,
        input.accountId,
        projectId,
      );
    audit(database, input, projectId, "project.initialization_link_rotated", projectId, {});
    return onboardingRow(database, input.accountId, projectId);
  }
  if (input.operation === "revokeInitializationToken") {
    requireGm(input);
    uuid(input.actorId, "actorId");
    const projectId = uuid(input.projectId, "projectId");
    const timestamp = now(input);
    database
      .prepare(
        `UPDATE project_onboarding SET initialization_token_status = 'revoked',
          initialization_revoked_at = ?, updated_at = ?, version = version + 1
         WHERE account_id = ? AND project_id = ? AND initialization_token_status <> 'absent'`,
      )
      .run(timestamp, timestamp, input.accountId, projectId);
    audit(database, input, projectId, "project.initialization_link_revoked", projectId, {});
    return onboardingRow(database, input.accountId, projectId);
  }
  if (input.operation === "loginIdentities")
    return database
      .prepare(
        "SELECT id, display_name AS displayName FROM users WHERE account_id = ? ORDER BY created_at, id",
      )
      .all(input.accountId);
  if (input.operation === "entry") {
    const entry = project(database, input);
    if (!entry.active) fail("PROJECT_NOT_ACCESSIBLE", "project is disabled");
    return entry;
  }
  if (input.operation === "login") {
    const selected = project(database, input);
    if (!selected.active) fail("PROJECT_NOT_ACCESSIBLE", "project is disabled");
    const userId = uuid(input.userId, "userId");
    const timestamp = now(input);
    if (!input.displayName || !input.email)
      fail("INVALID_REQUEST", "resolved identity is required");
    database
      .prepare(
        "INSERT OR IGNORE INTO users(id, account_id, email, display_name, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)",
      )
      .run(userId, input.accountId, input.email, input.displayName, timestamp, timestamp);
    const user = database
      .prepare("SELECT id, display_name, status FROM users WHERE account_id = ? AND id = ?")
      .get(input.accountId, userId) as
      { id: string; display_name: string; status: string } | undefined;
    if (!user || user.status !== "active") fail("AUTHENTICATION_FAILED", "identity is disabled");
    let membership = database
      .prepare(
        "SELECT id, status FROM memberships WHERE account_id = ? AND project_id = ? AND user_id = ?",
      )
      .get(input.accountId, selected.id, userId) as { id: string; status: string } | undefined;
    if (membership?.status === "revoked")
      fail("PROJECT_MEMBERSHIP_DISABLED", "项目成员已停用，请联系项目人员恢复");
    if (!membership) {
      membership = { id: projectMembershipId(selected.id, userId), status: "active" };
      database
        .prepare(
          "INSERT INTO memberships(id, account_id, project_id, user_id, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)",
        )
        .run(membership.id, input.accountId, selected.id, userId, timestamp, timestamp);
      audit(database, { ...input, actorId: userId }, selected.id, "membership.joined", userId, {
        status: "active",
      });
    }
    grantCapabilities(database, input.accountId, selected.id, membership.id, timestamp);
    const linked = database
      .prepare(
        `SELECT canonical.id, canonical.display_name FROM project_identity_links AS link
      JOIN users AS canonical ON canonical.account_id = link.account_id AND canonical.id = link.canonical_user_id AND canonical.status = 'active'
      JOIN memberships AS membership ON membership.account_id = link.account_id AND membership.project_id = link.project_id AND membership.user_id = canonical.id AND membership.status = 'active'
      WHERE link.account_id = ? AND link.project_id = ? AND link.source_user_id = ? AND link.status = 'active'`,
      )
      .get(input.accountId, selected.id, userId) as
      { id: string; display_name: string } | undefined;
    return {
      userId: linked?.id ?? userId,
      displayName: linked?.display_name ?? user.display_name,
      projectId: selected.id,
    };
  }
  uuid(input.actorId, "actorId");
  if (input.operation === "projectLogo") {
    const selected = project(database, input);
    requireProjectAccess(database, input, selected.id);
    const logo = onboardingRow(database, input.accountId, selected.id).logo;
    if (!logo) fail("NOT_FOUND", "project logo was not found");
    return logo;
  }
  if (input.operation === "recordProject") {
    const tables = {
      bug: "bugs",
      attachment: "attachments",
      capture: "capture_bundles",
      build: "builds",
      verification: "verifications",
      repair: "repair_attempts",
      upload: "upload_sessions",
      notification: "notifications",
    } as const;
    if (!input.recordType || !tables[input.recordType])
      fail("INVALID_REQUEST", "unsupported record type");
    uuid(input.recordId, "recordId");
    const row = database
      .prepare(`SELECT project_id FROM ${tables[input.recordType]} WHERE account_id = ? AND id = ?`)
      .get(input.accountId, input.recordId!) as { project_id: string } | undefined;
    if (!row || (input.projectId && row.project_id !== input.projectId))
      fail("NOT_FOUND", "record was not found in the requested project");
    requireProjectAccess(database, input, row.project_id);
    return { projectId: row.project_id };
  }
  if (input.operation === "list") {
    const rows = database
      .prepare(
        `SELECT project.id, project.project_key AS key, project.name, project.status, project.version FROM projects AS project
      JOIN accounts AS account ON account.id = project.account_id AND account.status = 'active'
      JOIN users AS actor ON actor.account_id = account.id AND actor.id = ? AND actor.status = 'active'
      WHERE project.account_id = ? AND (? = 1 OR (project.status = 'active' AND EXISTS (SELECT 1 FROM memberships WHERE account_id = project.account_id AND project_id = project.id AND user_id = actor.id AND status = 'active')))
      ORDER BY project.project_key, project.id`,
      )
      .all(input.actorId, input.accountId, input.isGm ? 1 : 0) as {
      id: string;
      key: string;
      name: string;
      status: string;
      version: number;
    }[];
    return {
      items: rows.map((row) => ({
        id: row.id,
        key: row.key,
        name: row.name,
        active: row.status === "active",
        version: row.version,
        roles: [input.isGm ? "gm" : "employee"],
      })),
      nextCursor: null,
    };
  }
  if (input.operation === "create") {
    requireGm(input);
    const projectId = uuid(input.projectId, "projectId");
    const timestamp = now(input);
    if (
      !input.key ||
      !/^[A-Z][A-Z0-9]{1,15}$/u.test(input.key) ||
      !input.name?.trim() ||
      input.name.length > 200
    )
      fail("INVALID_REQUEST", "project key or name is invalid");
    if (
      database
        .prepare("SELECT 1 FROM projects WHERE account_id = ? AND (id = ? OR project_key = ?)")
        .get(input.accountId, projectId, input.key)
    )
      fail("VERSION_CONFLICT", "project ID or key already exists");
    database
      .prepare(
        "INSERT INTO projects(id, account_id, project_key, name, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)",
      )
      .run(projectId, input.accountId, input.key, input.name.trim(), timestamp, timestamp);
    const membershipId = projectMembershipId(projectId, input.actorId);
    database
      .prepare(
        "INSERT INTO memberships(id, account_id, project_id, user_id, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, 'active', ?, ?, 1)",
      )
      .run(membershipId, input.accountId, projectId, input.actorId, timestamp, timestamp);
    grantCapabilities(database, input.accountId, projectId, membershipId, timestamp);
    audit(database, input, projectId, "project.created", projectId, {
      key: input.key,
      name: input.name.trim(),
    });
    return project(database, input);
  }
  const selected = project(database, input);
  if (input.operation === "update") {
    requireGm(input);
    requireVersion(selected.version, input.expectedVersion);
    const name = input.name?.trim() ?? selected.name;
    if (
      !name ||
      name.length > 200 ||
      (input.active !== undefined && typeof input.active !== "boolean")
    )
      fail("INVALID_REQUEST", "project update is invalid");
    database
      .prepare(
        "UPDATE projects SET name = ?, status = ?, updated_at = ?, version = version + 1 WHERE account_id = ? AND id = ? AND version = ?",
      )
      .run(
        name,
        (input.active ?? selected.active) ? "active" : "archived",
        now(input),
        input.accountId,
        selected.id,
        selected.version,
      );
    const onboarding = database
      .prepare(
        "SELECT initialization_status FROM project_onboarding WHERE account_id = ? AND project_id = ?",
      )
      .get(input.accountId, selected.id) as { initialization_status: string } | undefined;
    if (onboarding?.initialization_status === "ready" && name !== selected.name) {
      const normalizedNameKey = nameKey(input.nameKey, "project name key");
      if (
        database
          .prepare(
            "SELECT 1 FROM project_onboarding WHERE account_id = ? AND join_name_key = ? AND project_id <> ?",
          )
          .get(input.accountId, normalizedNameKey, selected.id)
      )
        fail("PROJECT_NAME_CONFLICT", "项目名称已被使用，请联系 GM 处理");
      database
        .prepare(
          "UPDATE project_onboarding SET join_name = ?, join_name_key = ?, updated_at = ?, version = version + 1 WHERE account_id = ? AND project_id = ?",
        )
        .run(name, normalizedNameKey, now(input), input.accountId, selected.id);
    }
    audit(database, input, selected.id, "project.updated", selected.id, {
      name,
      active: input.active ?? selected.active,
      previousVersion: selected.version,
    });
    return project(database, input);
  }
  requireProjectAccess(database, input, selected.id);
  if (input.operation === "comments") {
    const bugId = uuid(input.bugId, "bugId");
    const cursorScope = {
      kind: "comments" as const,
      accountId: input.accountId,
      projectId: selected.id,
      bugId,
    };
    const cursor = decodeScopedListCursor(input.cursor, cursorScope);
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      fail("INVALID_REQUEST", "limit must be between 1 and 500");
    if (
      !database
        .prepare(
          `SELECT 1 FROM bugs WHERE account_id = ? AND project_id = ? AND id = ? AND NOT EXISTS (SELECT 1 FROM bug_deletions WHERE bug_deletions.account_id = bugs.account_id AND bug_deletions.project_id = bugs.project_id AND bug_deletions.bug_id = bugs.id)`,
        )
        .get(input.accountId, selected.id, bugId)
    )
      fail("NOT_FOUND", "Bug was not found in this project");
    const rows = database
      .prepare(
        `SELECT id, body, author_id AS authorId, created_at AS createdAt FROM comments
       WHERE account_id = ? AND project_id = ? AND bug_id = ?
         AND (? IS NULL OR (created_at, id) > (?, ?))
       ORDER BY created_at, id LIMIT ?`,
      )
      .all(
        input.accountId,
        selected.id,
        bugId,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        limit + 1,
      ) as unknown as {
      id: string;
      body: string;
      authorId: string;
      createdAt: string;
    }[];
    const items = rows.slice(0, limit).map((item) => ({
      ...item,
      authorId: canonicalProjectUserId(
        database,
        { accountId: input.accountId, projectId: selected.id },
        item.authorId,
      ),
    }));
    return {
      projectId: selected.id,
      bugId,
      items,
      nextCursor: rows.length > limit ? encodeScopedListCursor(cursorScope, items.at(-1)!) : null,
    };
  }
  if (input.operation === "authorize") return { projectId: selected.id, authorized: true };
  if (input.operation === "membership") {
    const userId = uuid(input.userId, "userId");
    if (typeof input.active !== "boolean") fail("INVALID_REQUEST", "active is required");
    if (!input.isGm && userId === input.actorId)
      fail("FORBIDDEN", "the current user cannot disable itself");
    const existing = database
      .prepare(
        "SELECT id, status, version FROM memberships WHERE account_id = ? AND project_id = ? AND user_id = ?",
      )
      .get(input.accountId, selected.id, userId) as
      { id: string; status: string; version: number } | undefined;
    if (!existing && !input.isGm) fail("FORBIDDEN", "GM is required to assign an existing person");
    requireVersion(existing?.version ?? 0, input.expectedVersion);
    if (
      !database
        .prepare("SELECT 1 FROM users WHERE account_id = ? AND id = ? AND status = 'active'")
        .get(input.accountId, userId)
    )
      fail("NOT_FOUND", "active user was not found");
    const membershipId = existing?.id ?? projectMembershipId(selected.id, userId);
    const timestamp = now(input);
    if (!existing)
      database
        .prepare(
          "INSERT INTO memberships(id, account_id, project_id, user_id, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
        )
        .run(
          membershipId,
          input.accountId,
          selected.id,
          userId,
          input.active ? "active" : "revoked",
          timestamp,
          timestamp,
        );
    else
      database
        .prepare(
          "UPDATE memberships SET status = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?",
        )
        .run(input.active ? "active" : "revoked", timestamp, membershipId, existing.version);
    grantCapabilities(database, input.accountId, selected.id, membershipId, timestamp);
    audit(
      database,
      input,
      selected.id,
      input.active ? "membership.activated" : "membership.disabled",
      userId,
      { active: input.active, previousVersion: existing?.version ?? 0 },
    );
    return {
      projectId: selected.id,
      userId,
      active: input.active,
      version: (existing?.version ?? 0) + 1,
    };
  }
  if (input.operation === "components") return components(database, input, selected.id);
  if (input.operation === "setComponent") {
    requireGm(input);
    const key = input.componentKey;
    if (
      !key ||
      !PROJECT_COMPONENT_KEYS.includes(key) ||
      typeof input.enabled !== "boolean" ||
      !input.config ||
      Array.isArray(input.config)
    )
      fail("INVALID_REQUEST", "component settings are invalid");
    const serialized = JSON.stringify(input.config);
    if (serialized.length > 65536) fail("INVALID_REQUEST", "component configuration is too large");
    const current = components(database, { ...input, includePrivateConfig: true }, selected.id);
    const previous = current.items.find((item) => item.key === key)!;
    requireVersion(previous.version, input.expectedVersion);
    if (
      key === "build_upload.single" &&
      input.enabled &&
      ["build", "upload.incremental"].some(
        (dependency) => !current.items.find((item) => item.key === dependency)?.enabled,
      )
    )
      fail("COMPONENT_DEPENDENCY_REQUIRED", "enable build and upload.incremental first");
    const save = (
      componentKey: ProjectComponentKey,
      enabled: boolean,
      config: string,
      version: number,
    ) =>
      database
        .prepare(
          `INSERT INTO project_components(account_id, project_id, component_key, enabled, config_json, version, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, project_id, component_key) DO UPDATE SET enabled = excluded.enabled, config_json = excluded.config_json, version = excluded.version, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        )
        .run(
          input.accountId,
          selected.id,
          componentKey,
          enabled ? 1 : 0,
          config,
          version + 1,
          input.actorId,
          now(input),
        );
    save(key, input.enabled, serialized, previous.version);
    if (key === "build" || key === "upload.incremental") {
      const single = current.items.find((item) => item.key === "build_upload.single")!;
      if (single.enabled) {
        save(single.key, input.enabled, JSON.stringify(single.config), single.version);
        audit(
          database,
          input,
          selected.id,
          input.enabled ? "component.dependency_updated" : "component.dependency_disabled",
          single.key,
          { dependency: key },
        );
      }
    }
    audit(database, input, selected.id, "component.updated", key, {
      enabled: input.enabled,
      previousVersion: previous.version,
      changedConfigKeys: Object.keys(input.config).sort(),
    });
    return components(database, { ...input, includePrivateConfig: false }, selected.id);
  }
  if (input.operation === "audit")
    return {
      projectId: selected.id,
      items: database
        .prepare(
          "SELECT id, actor_id AS actorId, action, subject_id AS subjectId, summary_json AS summaryJson, created_at AS createdAt FROM project_management_events WHERE account_id = ? AND project_id = ? ORDER BY sequence DESC LIMIT 500",
        )
        .all(input.accountId, selected.id)
        .map((item) => ({
          ...item,
          actorId: canonicalProjectUserId(
            database,
            { accountId: input.accountId, projectId: selected.id },
            String(item.actorId),
          ),
        })),
    };
  return fail("INVALID_REQUEST", "unknown project operation");
}
