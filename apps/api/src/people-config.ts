import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type QaPersonRole = "fixer" | "verifier";

export interface QaPersonConfig {
  readonly id: string;
  readonly pinyin: string;
  readonly displayName: string;
  readonly roles: readonly QaPersonRole[];
  readonly active: boolean;
}

export interface QaPeopleConfig {
  readonly schemaVersion: 2;
  readonly projectKey: string;
  readonly people: readonly QaPersonConfig[];
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PINYIN_PATTERN = /^[a-z][a-z0-9]{1,63}$/u;
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
  if (actual.length !== required.length || actual.some((field, index) => field !== required[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}

function parsePerson(value: unknown, index: number): QaPersonConfig {
  const label = `qa people config people[${index}]`;
  const item = requireRecord(value, label);
  requireExactFields(item, ["id", "pinyin", "displayName", "roles", "active"], label);
  const id = typeof item["id"] === "string" ? item["id"].trim().toLowerCase() : "";
  const pinyin =
    typeof item["pinyin"] === "string" ? item["pinyin"].trim().toLowerCase() : "";
  const displayName =
    typeof item["displayName"] === "string" ? item["displayName"].trim() : "";
  if (!UUID_PATTERN.test(id)) throw new Error(`${label}.id is invalid`);
  if (!PINYIN_PATTERN.test(pinyin)) throw new Error(`${label}.pinyin is invalid`);
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
  return Object.freeze({ id, pinyin, displayName, roles: Object.freeze(roles), active: item["active"] });
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
  if (root["schemaVersion"] !== 2) throw new Error("qa people config schemaVersion is unsupported");
  const projectKey =
    typeof root["projectKey"] === "string" ? root["projectKey"].trim() : "";
  if (!PROJECT_KEY_PATTERN.test(projectKey)) throw new Error("qa people config projectKey is invalid");
  if (!Array.isArray(root["people"]) || root["people"].length > 200) {
    throw new Error("qa people config people is invalid");
  }
  const people = root["people"].map(parsePerson);
  const ids = new Set<string>();
  const pinyins = new Set<string>();
  for (const person of people) {
    if (!ids.add(person.id)) throw new Error("qa people config person id is duplicated");
    if (!pinyins.add(person.pinyin)) throw new Error("qa people config person pinyin is duplicated");
  }
  if (!people.some((person) => person.active)) {
    throw new Error("qa people config requires at least one active person");
  }
  return Object.freeze({ schemaVersion: 2, projectKey, people: Object.freeze(people) });
}

export function qaMembershipId(userId: string): string {
  if (userId === LEGACY_MEMBERSHIP_USER_ID) return LEGACY_MEMBERSHIP_ID;
  const digest = createHash("sha256").update(`qa-hub-membership:${userId}`, "utf8").digest("hex");
  const value = `${digest.slice(0, 12)}4${digest.slice(13, 16)}8${digest.slice(17, 32)}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
