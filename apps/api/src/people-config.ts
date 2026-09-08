import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pinyin } from "pinyin-pro";

export type QaPersonRole = "fixer" | "verifier";

export interface QaPersonConfig {
  readonly id: string;
  readonly displayName: string;
  readonly roles: readonly QaPersonRole[];
  readonly active: boolean;
}

export interface QaPeopleConfig {
  readonly schemaVersion: 4;
  readonly projectKey: string;
  readonly people: readonly QaPersonConfig[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_-]{1,31}$/u;
const ROLES = new Set<QaPersonRole>(["fixer", "verifier"]);
const DEFAULT_CONFIG_FILE = fileURLToPath(
  new URL("../../android/config/qa-people.json", import.meta.url),
);
const LEGACY_MEMBERSHIP_USER_ID = "10000000-0000-4000-8000-000000000003";
const LEGACY_MEMBERSHIP_ID = "10000000-0000-4000-8000-000000000005";

export interface QaLoginName {
  readonly displayName: string;
  readonly key: string;
}

export interface QaUserIdentity {
  readonly id: string;
  readonly displayName: string;
}

export function normalizeQaLoginName(value: string): QaLoginName {
  const displayName = value.normalize("NFKC").trim();
  if (
    displayName.length < 1 ||
    displayName.length > 100 ||
    /[\u0000-\u001f\u007f]/u.test(displayName)
  ) {
    throw new TypeError("name is invalid");
  }
  return Object.freeze({ displayName, key: displayName.toLocaleLowerCase("en-US") });
}

const CHINESE_PERSON_NAME_PATTERN = /^(?:\p{Script=Han}|·){2,20}$/u;
const PINYIN_LOGIN_PATTERN = /^[a-zv\s'-]+$/u;

function pinyinLoginKey(value: string): string | undefined {
  const normalized = normalizeQaLoginName(value).key;
  if (!PINYIN_LOGIN_PATTERN.test(normalized)) return undefined;
  const compact = normalized.replace(/[\s'-]/gu, "");
  return compact.length > 0 ? compact : undefined;
}

export function qaPinyinLoginAlias(displayName: string): string | undefined {
  const normalized = normalizeQaLoginName(displayName).displayName;
  if (!CHINESE_PERSON_NAME_PATTERN.test(normalized) || !/\p{Script=Han}/u.test(normalized)) {
    return undefined;
  }
  const alias = pinyin(normalized, {
    type: "array",
    toneType: "none",
    surname: "head",
    nonZh: "removed",
    v: true,
  }).join("");
  return /^[a-zv]+$/u.test(alias) ? alias : undefined;
}

/**
 * Resolves names only against Chinese identities that already exist. Pinyin
 * collisions deliberately remain unresolved instead of selecting a person.
 */
export class QaLoginDirectory {
  readonly #canonicalByDisplayName = new Map<string, QaUserIdentity>();
  readonly #canonicalById = new Map<string, QaUserIdentity>();
  readonly #canonicalByPinyin = new Map<string, QaUserIdentity | null>();
  readonly #linkedByDisplayName = new Map<string, QaUserIdentity>();
  readonly #linkedById = new Map<string, QaUserIdentity>();
  readonly #linksBySourceId = new Map<
    string,
    { readonly sourceKey: string; readonly canonical: QaUserIdentity }
  >();

  constructor(identities: readonly QaUserIdentity[] = []) {
    for (const identity of identities) this.register(identity);
  }

  register(identity: QaUserIdentity): void {
    const normalized = normalizeQaLoginName(identity.displayName);
    const stored = Object.freeze({ id: identity.id, displayName: normalized.displayName });
    const alias = qaPinyinLoginAlias(normalized.displayName);
    const existingName = this.#canonicalByDisplayName.get(normalized.key);
    const canonical = existingName ?? stored;
    if (existingName === undefined) {
      this.#canonicalByDisplayName.set(normalized.key, canonical);
      this.#canonicalById.set(canonical.id, canonical);
    }

    if (alias === undefined) return;
    const existingAlias = this.#canonicalByPinyin.get(alias);
    if (existingAlias === undefined) this.#canonicalByPinyin.set(alias, canonical);
    else if (existingAlias !== null && existingAlias.id !== canonical.id) {
      this.#canonicalByPinyin.set(alias, null);
    }
  }

  resolveLogin(loginName: string): QaUserIdentity | undefined {
    const normalized = normalizeQaLoginName(loginName);
    const linked = this.#linkedByDisplayName.get(normalized.key);
    if (linked !== undefined) return linked;
    const exact = this.#canonicalByDisplayName.get(normalized.key);
    if (exact !== undefined) return exact;
    const alias = pinyinLoginKey(normalized.key);
    if (alias === undefined) return undefined;
    return this.#canonicalByPinyin.get(alias) ?? undefined;
  }

  canonicalize(identity: QaUserIdentity): QaUserIdentity {
    const linked = this.#linkedById.get(identity.id);
    if (linked !== undefined) return linked;
    const byId = this.#canonicalById.get(identity.id);
    if (byId !== undefined) return byId;
    return this.resolveLogin(identity.displayName) ?? identity;
  }

  registerLink(source: QaUserIdentity, canonical: QaUserIdentity): void {
    if (source.id === canonical.id) throw new TypeError("identity link cannot target itself");
    const sourceName = normalizeQaLoginName(source.displayName);
    const canonicalName = normalizeQaLoginName(canonical.displayName);
    const storedCanonical = Object.freeze({
      id: canonical.id,
      displayName: canonicalName.displayName,
    });
    this.removeLink(source.id);
    this.#linkedById.set(source.id, storedCanonical);
    this.#linkedByDisplayName.set(sourceName.key, storedCanonical);
    this.#linksBySourceId.set(source.id, {
      sourceKey: sourceName.key,
      canonical: storedCanonical,
    });
  }

  removeLink(sourceId: string): void {
    const existing = this.#linksBySourceId.get(sourceId);
    if (existing === undefined) return;
    this.#linksBySourceId.delete(sourceId);
    this.#linkedById.delete(sourceId);
    if (this.#linkedByDisplayName.get(existing.sourceKey)?.id === existing.canonical.id) {
      this.#linkedByDisplayName.delete(existing.sourceKey);
    }
  }

  linkedUserIds(canonicalUserId: string): readonly string[] {
    return Object.freeze(
      [...this.#linksBySourceId.entries()]
        .filter(([, link]) => link.canonical.id === canonicalUserId)
        .map(([sourceUserId]) => sourceUserId)
        .sort(),
    );
  }
}

export function qaLoginEmail(accountId: string, loginName: string): string {
  const { key } = normalizeQaLoginName(loginName);
  const digest = createHash("sha256")
    .update(`qa-hub-login:${accountId}:${key}`, "utf8")
    .digest("hex");
  return `qa-${digest}@local.invalid`;
}

export function qaUserId(accountId: string, loginName: string): string {
  const { key } = normalizeQaLoginName(loginName);
  const digest = createHash("sha256")
    .update(`qa-hub-user:${accountId}:${key}`, "utf8")
    .digest("hex");
  const value = `${digest.slice(0, 12)}4${digest.slice(13, 16)}8${digest.slice(17, 32)}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactFields(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((field, index) => field !== required[index])
  ) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}

function parsePerson(value: unknown, index: number): QaPersonConfig {
  const label = `qa people config people[${index}]`;
  const item = requireRecord(value, label);
  requireExactFields(item, ["id", "displayName", "roles", "active"], label);
  const id = typeof item["id"] === "string" ? item["id"].trim().toLowerCase() : "";
  const displayName = typeof item["displayName"] === "string" ? item["displayName"].trim() : "";
  if (!UUID_PATTERN.test(id)) throw new Error(`${label}.id is invalid`);
  if (displayName.length < 1 || displayName.length > 100) {
    throw new Error(`${label}.displayName is invalid`);
  }
  if (!Array.isArray(item["roles"]) || item["roles"].length < 1 || item["roles"].length > 2) {
    throw new Error(`${label}.roles is invalid`);
  }
  const roles = item["roles"].map((role) => {
    if (typeof role !== "string" || !ROLES.has(role as QaPersonRole)) {
      throw new Error(`${label}.roles contains an unsupported role`);
    }
    return role as QaPersonRole;
  });
  if (new Set(roles).size !== roles.length) throw new Error(`${label}.roles is duplicated`);
  if (typeof item["active"] !== "boolean") throw new Error(`${label}.active is invalid`);
  return Object.freeze({
    id,
    displayName,
    roles: Object.freeze(roles),
    active: item["active"],
  });
}

export function resolveQaPeopleConfigFile(configured: string | undefined): string {
  const value = configured?.trim();
  return value === undefined || value.length === 0 ? DEFAULT_CONFIG_FILE : resolve(value);
}

export function loadQaPeopleConfig(configuredFile?: string): QaPeopleConfig {
  const configFile = resolveQaPeopleConfigFile(configuredFile);
  const raw = readFileSync(configFile, "utf8");
  if (Buffer.byteLength(raw, "utf8") > 128 * 1024) {
    throw new Error("qa people config is too large");
  }
  const root = requireRecord(JSON.parse(raw) as unknown, "qa people config");
  requireExactFields(root, ["schemaVersion", "projectKey", "people"], "qa people config");
  if (root["schemaVersion"] !== 4) throw new Error("qa people config schemaVersion is unsupported");
  const projectKey = typeof root["projectKey"] === "string" ? root["projectKey"].trim() : "";
  if (!PROJECT_KEY_PATTERN.test(projectKey))
    throw new Error("qa people config projectKey is invalid");
  if (!Array.isArray(root["people"]) || root["people"].length > 200) {
    throw new Error("qa people config people is invalid");
  }
  const people = root["people"].map(parsePerson);
  const ids = new Set<string>();
  for (const person of people) {
    if (!ids.add(person.id)) throw new Error("qa people config person id is duplicated");
  }
  return Object.freeze({ schemaVersion: 4, projectKey, people: Object.freeze(people) });
}

export function qaMembershipId(userId: string, projectId?: string): string {
  if (projectId !== undefined) {
    const digest = createHash("sha256")
      .update(`qa-hub-project-membership:${projectId}:${userId}`, "utf8")
      .digest("hex");
    return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  }
  if (userId === LEGACY_MEMBERSHIP_USER_ID) return LEGACY_MEMBERSHIP_ID;
  const digest = createHash("sha256").update(`qa-hub-membership:${userId}`, "utf8").digest("hex");
  const value = `${digest.slice(0, 12)}4${digest.slice(13, 16)}8${digest.slice(17, 32)}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
