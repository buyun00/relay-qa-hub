import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { canonicalProjectUserId } from "./project-identity-projection.js";
import { SqliteStorageError } from "./sqlite.js";

const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_OPTIONS = Object.freeze({
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024,
});
const SCRYPT_HASH_PREFIX = "scrypt";
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_DUMMY_SALT = Buffer.from("qa-hub-browser-auth-dummy", "utf8");
const SCRYPT_DUMMY_DIGEST = scryptSync(
  "qa-hub-browser-auth-dummy-password",
  SCRYPT_DUMMY_SALT,
  SCRYPT_KEY_LENGTH,
  SCRYPT_OPTIONS,
);

export interface EnsureBrowserAdminInput {
  readonly accountId: string;
  readonly userId: string;
  readonly password: string;
  readonly now: string;
}

export interface EnsureBrowserAdminResult {
  readonly created: boolean;
}

export interface LoginBrowserSessionInput {
  readonly accountId: string;
  readonly email: string;
  readonly password: string;
  readonly sessionId: string;
  readonly tokenDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** Compatibility input for callers that carry an explicit initial last-seen timestamp. */
  readonly lastSeenAt?: string;
}

export interface CreateBrowserSessionInput {
  readonly accountId: string;
  readonly userId: string;
  readonly projectId?: string;
  readonly isGm?: boolean;
  readonly sessionId: string;
  readonly tokenDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt?: string;
}

export interface ResolveBrowserSessionInput {
  readonly tokenDigest: string;
  readonly now: string;
}

export interface RevokeBrowserSessionInput {
  readonly tokenDigest: string;
  readonly now: string;
  readonly reason: string;
}

export interface BrowserPrincipal {
  readonly accountId: string;
  readonly userId: string;
  readonly actorId: string;
  readonly email: string;
  readonly displayName: string;
  readonly projectId?: string;
  readonly isGm?: boolean;
}

export interface ActiveAccountUser {
  readonly userId: string;
  readonly displayName: string;
}

export function listActiveAccountUsers(
  database: DatabaseSync,
  accountId: string,
): readonly ActiveAccountUser[] {
  const rows = database
    .prepare(
      `SELECT user.id AS user_id, user.display_name AS display_name
       FROM accounts AS account
       JOIN users AS user
         ON user.account_id = account.id
        AND user.status = 'active'
       WHERE account.id = ? AND account.status = 'active'
       ORDER BY user.display_name COLLATE NOCASE ASC, user.id ASC`,
    )
    .all(accountId) as unknown as {
    readonly user_id: string;
    readonly display_name: string;
  }[];
  return Object.freeze(
    rows.map((row) => Object.freeze({ userId: row.user_id, displayName: row.display_name })),
  );
}

function requireTransaction(database: DatabaseSync): void {
  if (!database.isTransaction) {
    throw new SqliteStorageError(
      "SQLITE_TRANSACTION_REQUIRED",
      "browser authentication writes require the caller's write transaction",
    );
  }
}

function requireTokenDigest(tokenDigest: string): void {
  if (!/^[0-9a-f]{64}$/.test(tokenDigest)) {
    throw new SqliteStorageError(
      "SQLITE_CONFIGURATION_INVALID",
      "browser session token digest must be 64 lowercase hexadecimal characters",
    );
  }
}

function requirePassword(password: string): void {
  if (password.length === 0) {
    throw new SqliteStorageError("SQLITE_CONFIGURATION_INVALID", "browser password is required");
  }
}

function encodePassword(password: string): string {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const digest = scryptSync(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS);
  return [
    SCRYPT_HASH_PREFIX,
    String(SCRYPT_OPTIONS.N),
    String(SCRYPT_OPTIONS.r),
    String(SCRYPT_OPTIONS.p),
    salt.toString("hex"),
    digest.toString("hex"),
  ].join("$");
}

interface ParsedPasswordHash {
  readonly salt: Buffer;
  readonly digest: Buffer;
  readonly options: {
    readonly N: number;
    readonly r: number;
    readonly p: number;
    readonly maxmem: number;
  };
}

function parsePasswordHash(value: string): ParsedPasswordHash | null {
  const parts = value.split("$");
  const [prefix, nValue, rValue, pValue, saltHex, digestHex] = parts;
  if (
    parts.length !== 6 ||
    prefix !== SCRYPT_HASH_PREFIX ||
    nValue === undefined ||
    rValue === undefined ||
    pValue === undefined ||
    saltHex === undefined ||
    digestHex === undefined
  ) {
    return null;
  }
  const N = Number(nValue);
  const r = Number(rValue);
  const p = Number(pValue);
  if (
    !Number.isSafeInteger(N) ||
    !Number.isSafeInteger(r) ||
    !Number.isSafeInteger(p) ||
    N < 2 ||
    (N & (N - 1)) !== 0 ||
    r < 1 ||
    p < 1 ||
    !/^[0-9a-f]{32}$/.test(saltHex) ||
    !/^[0-9a-f]{128}$/.test(digestHex)
  ) {
    return null;
  }
  return {
    salt: Buffer.from(saltHex, "hex"),
    digest: Buffer.from(digestHex, "hex"),
    options: { N, r, p, maxmem: 32 * 1024 * 1024 },
  };
}

function verifyPassword(password: string, storedHash: string | null): boolean {
  const parsed = storedHash === null ? null : parsePasswordHash(storedHash);
  const expected = parsed === null ? SCRYPT_DUMMY_DIGEST : parsed.digest;
  const derived = scryptSync(
    password,
    parsed === null ? SCRYPT_DUMMY_SALT : parsed.salt,
    expected.length,
    parsed === null ? SCRYPT_OPTIONS : parsed.options,
  );
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

function authenticationFailed(): never {
  throw Object.assign(new Error("browser authentication failed"), {
    code: "AUTHENTICATION_FAILED",
  });
}

export function ensureBrowserAdmin(
  database: DatabaseSync,
  input: EnsureBrowserAdminInput,
): EnsureBrowserAdminResult {
  requireTransaction(database);
  requirePassword(input.password);
  const existing = database
    .prepare(
      `SELECT 1 AS present
       FROM local_credentials
       WHERE account_id = ? AND user_id = ?`,
    )
    .get(input.accountId, input.userId) as { readonly present: number } | undefined;
  if (existing !== undefined) return Object.freeze({ created: false });

  const result = database
    .prepare(
      `INSERT OR IGNORE INTO local_credentials(
        id, account_id, user_id, password_hash, algorithm,
        failed_attempts, locked_until, changed_at, version
      ) VALUES (?, ?, ?, ?, 'scrypt', 0, NULL, ?, 1)`,
    )
    .run(randomUUID(), input.accountId, input.userId, encodePassword(input.password), input.now);
  return Object.freeze({ created: result.changes === 1 });
}

export function loginBrowserSession(
  database: DatabaseSync,
  input: LoginBrowserSessionInput,
): BrowserPrincipal {
  requireTransaction(database);
  requireTokenDigest(input.tokenDigest);
  requirePassword(input.password);
  const row = database
    .prepare(
      `SELECT user.id AS user_id, user.email AS email,
              user.display_name AS display_name,
              credential.password_hash AS password_hash
       FROM accounts AS account
       JOIN users AS user
         ON user.account_id = account.id
       LEFT JOIN local_credentials AS credential
         ON credential.account_id = user.account_id
        AND credential.user_id = user.id
       WHERE account.id = ?
         AND account.status = 'active'
         AND user.email = ?
         AND user.status = 'active'`,
    )
    .get(input.accountId, input.email) as
    | {
        readonly user_id: string;
        readonly email: string;
        readonly display_name: string;
        readonly password_hash: string | null;
      }
    | undefined;

  if (!verifyPassword(input.password, row?.password_hash ?? null)) authenticationFailed();

  if (!row) authenticationFailed();
  database
    .prepare(
      `INSERT INTO browser_sessions(
        id, account_id, user_id, token_digest, issued_at, expires_at,
        last_seen_at, revoked_at, revoked_reason, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1)`,
    )
    .run(
      input.sessionId,
      input.accountId,
      row.user_id,
      input.tokenDigest,
      input.issuedAt,
      input.expiresAt,
      input.lastSeenAt ?? input.issuedAt,
    );
  return Object.freeze({
    accountId: input.accountId,
    userId: row.user_id,
    actorId: row.user_id,
    email: row.email,
    displayName: row.display_name,
  });
}

export function createBrowserSession(
  database: DatabaseSync,
  input: CreateBrowserSessionInput,
): BrowserPrincipal {
  requireTransaction(database);
  requireTokenDigest(input.tokenDigest);
  const row = database
    .prepare(
      `SELECT user.id AS user_id, user.email AS email,
              user.display_name AS display_name
       FROM accounts AS account
       JOIN users AS user
         ON user.account_id = account.id
       WHERE account.id = ?
         AND account.status = 'active'
         AND user.id = ?
         AND user.status = 'active'`,
    )
    .get(input.accountId, input.userId) as
    | {
        readonly user_id: string;
        readonly email: string;
        readonly display_name: string;
      }
    | undefined;
  if (!row) authenticationFailed();
  if (
    input.projectId !== undefined &&
    !database
      .prepare(
        `SELECT 1 FROM projects AS project
    WHERE project.account_id = ? AND project.id = ? AND project.status = 'active'
    AND (? = 1 OR EXISTS (SELECT 1 FROM memberships WHERE account_id = project.account_id AND project_id = project.id AND user_id = ? AND status = 'active'))`,
      )
      .get(input.accountId, input.projectId, input.isGm ? 1 : 0, input.userId)
  )
    authenticationFailed();
  database
    .prepare(
      `INSERT INTO browser_sessions(
        id, account_id, user_id, token_digest, issued_at, expires_at,
        last_seen_at, revoked_at, revoked_reason, version, login_project_id, is_gm
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?)`,
    )
    .run(
      input.sessionId,
      input.accountId,
      row.user_id,
      input.tokenDigest,
      input.issuedAt,
      input.expiresAt,
      input.lastSeenAt ?? input.issuedAt,
      input.projectId ?? null,
      input.isGm ? 1 : 0,
    );
  return Object.freeze({
    accountId: input.accountId,
    userId: row.user_id,
    actorId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.isGm ? { isGm: true } : {}),
  });
}

export function resolveBrowserSession(
  database: DatabaseSync,
  input: ResolveBrowserSessionInput,
): BrowserPrincipal | null {
  requireTokenDigest(input.tokenDigest);
  const row = database
    .prepare(
      `SELECT session.account_id AS account_id,
              session.user_id AS user_id,
              session.login_project_id AS login_project_id,
              session.is_gm AS is_gm,
              user.email AS email,
              user.display_name AS display_name
       FROM browser_sessions AS session
       JOIN accounts AS account
         ON account.id = session.account_id
       JOIN users AS user
         ON user.account_id = session.account_id
        AND user.id = session.user_id
       WHERE session.token_digest = ?
         AND session.revoked_at IS NULL
         AND account.status = 'active'
         AND user.status = 'active'
         AND (
           session.is_gm = 1
           OR session.login_project_id IS NULL
           OR EXISTS (
             SELECT 1 FROM memberships
             WHERE memberships.account_id = session.account_id
               AND memberships.project_id = session.login_project_id
               AND memberships.user_id = session.user_id
               AND memberships.status = 'active'
           )
         )`,
    )
    .get(input.tokenDigest) as
    | {
        readonly account_id: string;
        readonly user_id: string;
        readonly login_project_id: string | null;
        readonly is_gm: number;
        readonly email: string;
        readonly display_name: string;
      }
    | undefined;
  if (!row) return null;
  const projectedUserId =
    row.login_project_id === null
      ? row.user_id
      : canonicalProjectUserId(
          database,
          { accountId: row.account_id, projectId: row.login_project_id },
          row.user_id,
        );
  const projectedUser =
    projectedUserId === row.user_id
      ? row
      : (database
          .prepare(
            `SELECT email, display_name
             FROM users
             WHERE account_id = ? AND id = ? AND status = 'active'`,
          )
          .get(row.account_id, projectedUserId) as
          { readonly email: string; readonly display_name: string } | undefined);
  if (!projectedUser) return null;
  return Object.freeze({
    accountId: row.account_id,
    userId: projectedUserId,
    actorId: projectedUserId,
    email: projectedUser.email,
    displayName: projectedUser.display_name,
    ...(row.login_project_id === null ? {} : { projectId: row.login_project_id }),
    ...(row.is_gm === 1 ? { isGm: true } : {}),
  });
}

export function revokeBrowserSession(
  database: DatabaseSync,
  input: RevokeBrowserSessionInput,
): boolean {
  requireTransaction(database);
  requireTokenDigest(input.tokenDigest);
  const row = database
    .prepare(
      `SELECT id, version, revoked_at
       FROM browser_sessions
       WHERE token_digest = ?`,
    )
    .get(input.tokenDigest) as
    | { readonly id: string; readonly version: number; readonly revoked_at: string | null }
    | undefined;
  if (!row) return false;
  if (row.revoked_at !== null) return true;
  const result = database
    .prepare(
      `UPDATE browser_sessions
       SET revoked_at = ?, revoked_reason = ?, version = version + 1
       WHERE id = ? AND token_digest = ? AND version = ? AND revoked_at IS NULL`,
    )
    .run(input.now, input.reason, row.id, input.tokenDigest, row.version);
  return result.changes === 1;
}
