export const MOBILE_API_MEDIA_TYPE = "application/vnd.relay-qa-hub.v1.1+json" as const;
export const MOBILE_API_CONTENT_TYPE = `${MOBILE_API_MEDIA_TYPE}; charset=utf-8` as const;
export const MOBILE_BUG_COLLECTION_PATH = "/api/v1/bugs" as const;
export const MOBILE_BUG_ITEM_PATH = "/api/v1/bugs/:bugId" as const;
export const DEFAULT_DEBUG_BEARER_TOKEN = "relay-qa-hub-local-debug" as const;
export const DEFAULT_DEBUG_ACTOR_ID = "10000000-0000-4000-8000-000000000003" as const;

export type MobileBugState =
  | "reported"
  | "needs_info"
  | "ready"
  | "in_progress"
  | "awaiting_build"
  | "ready_for_verification"
  | "closed"
  | "deferred"
  | "rejected"
  | "duplicate";

export type MobileBugSeverity = "S0" | "S1" | "S2" | "S3" | "S4";
export type MobileBugPriority = "P0" | "P1" | "P2" | "P3" | "P4";
export type MobileBugListSort = "updated_desc" | "created_desc" | "priority_desc";
export type MobileOccurrencePlatform =
  "android" | "ios" | "windows" | "macos" | "linux" | "web" | "other";

export type MobileOccurrenceEnvironmentValue = string | number | boolean | null;

export interface MobileOccurrenceDraft {
  readonly observedAt: string;
  readonly platform: MobileOccurrencePlatform;
  readonly appVersion?: string | null;
  readonly resourceVersion?: string | null;
  readonly gitSha?: string | null;
  readonly deviceModel?: string | null;
  readonly osVersion?: string | null;
  readonly steps: readonly string[];
  readonly actualBehavior: string;
  readonly frequency?: string | null;
  readonly errorSignature?: string | null;
  readonly environment?: Readonly<Record<string, MobileOccurrenceEnvironmentValue>>;
}

export interface MobileCreateBugRequest {
  readonly submissionContractVersion: "1.1.0";
  readonly projectId: string;
  readonly clientSubmissionId: string;
  readonly title: string;
  readonly description: string;
  readonly expectedBehavior: string;
  readonly moduleId?: string | null;
  readonly ownerId?: string | null;
  readonly verificationOwnerId?: string | null;
  readonly severity: MobileBugSeverity;
  readonly priority: MobileBugPriority;
  readonly occurrence: MobileOccurrenceDraft;
  readonly attachmentIds?: readonly string[];
  readonly captureBundleId?: string | null;
}

export interface MobileBug {
  readonly id: string;
  readonly projectId: string;
  readonly number: number;
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly expectedBehavior: string;
  readonly moduleId: string | null;
  readonly state: MobileBugState;
  readonly severity: MobileBugSeverity;
  readonly priority: MobileBugPriority;
  readonly reporterId: string;
  readonly ownerId: string | null;
  readonly verificationOwnerId: string | null;
  readonly duplicateOfBugId: string | null;
  readonly occurrenceCount: number;
  readonly reopenCount: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export interface MobileCreateBugResponse {
  readonly clientSubmissionId: string;
  readonly qaItem: {
    readonly type: "bug";
    readonly id: string;
    readonly key: string;
  };
  readonly disposition: "created";
  readonly bug: MobileBug;
  readonly occurrenceId: string;
  readonly attachmentIds: readonly string[];
  readonly captureBundleId: string | null;
  readonly eventId: string;
  readonly replayed: boolean;
}

export interface CreateMobileBugCommand {
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly request: MobileCreateBugRequest;
}

export interface GetMobileBugQuery {
  readonly actorId: string;
  readonly bugId: string;
}

export interface MobileUpdateBugRequest {
  readonly expectedVersion: number;
  readonly title?: string;
  readonly description?: string;
  readonly expectedBehavior?: string;
  readonly moduleId?: string | null;
  readonly severity?: MobileBugSeverity;
  readonly priority?: MobileBugPriority;
  readonly ownerId?: string | null;
  readonly verificationOwnerId?: string | null;
  /** Complete ordered-independent set of attachments that should remain visible on the Bug. */
  readonly attachmentIds?: readonly string[];
}

export interface UpdateMobileBugCommand {
  readonly actorId: string;
  readonly bugId: string;
  readonly idempotencyKey: string;
  readonly request: MobileUpdateBugRequest;
}

export interface DeleteMobileBugCommand {
  readonly actorId: string;
  readonly bugId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
}

export interface MobileDeleteBugResponse {
  readonly bugId: string;
  readonly deletedAt: string;
  readonly replayed: boolean;
}

export interface MobileBugListQuery {
  readonly actorId: string;
  readonly projectId?: string;
  readonly ownerId?: string;
  readonly verificationOwnerId?: string;
  readonly ownerState?: "assigned" | "unassigned";
  readonly q?: string;
  readonly state?: readonly MobileBugState[];
  readonly reporterId?: string;
  readonly moduleId?: string;
  readonly severity?: MobileBugSeverity;
  readonly priority?: MobileBugPriority;
  readonly updatedAfter?: string;
  readonly sort?: MobileBugListSort;
  readonly cursor?: string;
  readonly limit: number;
}

export interface MobileBugListResponse {
  readonly snapshotSequence: number;
  readonly items: readonly MobileBug[];
  readonly nextCursor: string | null;
}

export interface MobileBugStore {
  readonly createBug: (
    command: CreateMobileBugCommand,
  ) => MobileCreateBugResponse | Promise<MobileCreateBugResponse>;
  readonly listBugs: (
    query: MobileBugListQuery,
  ) => MobileBugListResponse | Promise<MobileBugListResponse>;
  readonly getBug: (query: GetMobileBugQuery) => MobileBug | null | Promise<MobileBug | null>;
  readonly updateBug: (command: UpdateMobileBugCommand) => MobileBug | Promise<MobileBug>;
  readonly deleteBug: (
    command: DeleteMobileBugCommand,
  ) => MobileDeleteBugResponse | Promise<MobileDeleteBugResponse>;
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const CREATE_KEYS = new Set([
  "submissionContractVersion",
  "projectId",
  "clientSubmissionId",
  "title",
  "description",
  "expectedBehavior",
  "moduleId",
  "ownerId",
  "verificationOwnerId",
  "severity",
  "priority",
  "occurrence",
  "attachmentIds",
  "captureBundleId",
]);
const OCCURRENCE_KEYS = new Set([
  "observedAt",
  "platform",
  "appVersion",
  "resourceVersion",
  "gitSha",
  "deviceModel",
  "osVersion",
  "steps",
  "actualBehavior",
  "frequency",
  "errorSignature",
  "environment",
]);
const ENVIRONMENT_KEYS = new Set([
  "qaAppVersion",
  "testSessionId",
  "buildId",
  "networkType",
  "networkMetered",
  "orientation",
]);
const SEVERITIES = new Set<MobileBugSeverity>(["S0", "S1", "S2", "S3", "S4"]);
const PRIORITIES = new Set<MobileBugPriority>(["P0", "P1", "P2", "P3", "P4"]);
const PLATFORMS = new Set<MobileOccurrencePlatform>([
  "android",
  "ios",
  "windows",
  "macos",
  "linux",
  "web",
  "other",
]);
const BUG_STATES = new Set<MobileBugState>([
  "reported",
  "needs_info",
  "ready",
  "in_progress",
  "awaiting_build",
  "ready_for_verification",
  "closed",
  "deferred",
  "rejected",
  "duplicate",
]);

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

function queryStrings(value: Record<string, unknown>, key: string): readonly string[] | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  const values = Array.isArray(candidate) ? candidate : [candidate];
  if (
    values.length < 1 ||
    values.length > 12 ||
    values.some((entry) => typeof entry !== "string")
  ) {
    throw new TypeError(`${key} must contain from 1 through 12 strings`);
  }
  return values as readonly string[];
}

function isDateTime(value: string): boolean {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return false;
  }
  const [datePart, timePart] = value.split("T");
  const [year, month, day] = datePart!.split("-").map(Number);
  const [hour, minute, second] = timePart!.slice(0, 8).split(":").map(Number);
  if (hour! > 23 || minute! > 59 || second! > 59) return false;
  const calendar = new Date(0);
  calendar.setUTCHours(0, 0, 0, 0);
  calendar.setUTCFullYear(year!, month! - 1, day!);
  return (
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month! - 1 &&
    calendar.getUTCDate() === day
  );
}

export function parseMobileBugListQuery(value: unknown): Omit<MobileBugListQuery, "actorId"> {
  const query = requireRecord(value, "Bug list query");
  requireOnlyKeys(
    query,
    new Set([
      "projectId",
      "ownerId",
      "verificationOwnerId",
      "ownerState",
      "q",
      "state",
      "reporterId",
      "moduleId",
      "severity",
      "priority",
      "updatedAfter",
      "sort",
      "cursor",
      "limit",
    ]),
  );
  const projectId = queryString(query, "projectId");
  if (projectId !== undefined) requireUuid(projectId, "projectId");
  const ownerId = queryString(query, "ownerId");
  if (ownerId !== undefined) requireUuid(ownerId, "ownerId");
  const verificationOwnerId = queryString(query, "verificationOwnerId");
  if (verificationOwnerId !== undefined) requireUuid(verificationOwnerId, "verificationOwnerId");
  const ownerStateValue = queryString(query, "ownerState");
  if (
    ownerStateValue !== undefined &&
    ownerStateValue !== "assigned" &&
    ownerStateValue !== "unassigned"
  ) {
    throw new TypeError("ownerState must be assigned or unassigned");
  }
  if (ownerId !== undefined && ownerStateValue !== undefined) {
    throw new TypeError("ownerId and ownerState cannot be combined");
  }

  const queryValue = queryString(query, "q");
  const normalizedQuery = queryValue?.trim();
  if (
    queryValue !== undefined &&
    (normalizedQuery === undefined || normalizedQuery.length < 1 || normalizedQuery.length > 200)
  ) {
    throw new TypeError("q is invalid");
  }

  const stateValues = queryStrings(query, "state");
  if (stateValues?.some((state) => !BUG_STATES.has(state as MobileBugState))) {
    throw new TypeError("state is invalid");
  }
  const states =
    stateValues === undefined
      ? undefined
      : Object.freeze([...new Set(stateValues as readonly MobileBugState[])].sort());

  const reporterId = queryString(query, "reporterId");
  if (reporterId !== undefined) requireUuid(reporterId, "reporterId");
  const moduleId = queryString(query, "moduleId");
  if (moduleId !== undefined) requireUuid(moduleId, "moduleId");

  const severityValue = queryString(query, "severity");
  if (severityValue !== undefined && !SEVERITIES.has(severityValue as MobileBugSeverity)) {
    throw new TypeError("severity is invalid");
  }

  const priorityValue = queryString(query, "priority");
  if (priorityValue !== undefined && !PRIORITIES.has(priorityValue as MobileBugPriority)) {
    throw new TypeError("priority is invalid");
  }

  const updatedAfterValue = queryString(query, "updatedAfter");
  const updatedAfter =
    updatedAfterValue === undefined
      ? undefined
      : isDateTime(updatedAfterValue)
        ? new Date(Date.parse(updatedAfterValue)).toISOString()
        : undefined;
  if (updatedAfterValue !== undefined && updatedAfter === undefined) {
    throw new TypeError("updatedAfter is invalid");
  }

  const sortValue = queryString(query, "sort");
  if (
    sortValue !== undefined &&
    !(["updated_desc", "created_desc", "priority_desc"] as const).includes(
      sortValue as MobileBugListSort,
    )
  ) {
    throw new TypeError("sort is invalid");
  }

  const cursor = queryString(query, "cursor");
  if (cursor !== undefined && !/^[A-Za-z0-9_.-]{1,500}$/u.test(cursor)) {
    throw new TypeError("cursor is invalid");
  }

  const limitValue = queryString(query, "limit");
  const limit = limitValue === undefined ? 50 : Number(limitValue);
  if (
    (limitValue !== undefined && !/^\d+$/u.test(limitValue)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 500
  ) {
    throw new TypeError("limit must be an integer from 1 through 500");
  }
  return {
    ...(projectId === undefined ? {} : { projectId }),
    ...(ownerId === undefined ? {} : { ownerId }),
    ...(verificationOwnerId === undefined ? {} : { verificationOwnerId }),
    ...(ownerStateValue === undefined
      ? {}
      : { ownerState: ownerStateValue as "assigned" | "unassigned" }),
    ...(normalizedQuery === undefined ? {} : { q: normalizedQuery }),
    ...(states === undefined ? {} : { state: states }),
    ...(reporterId === undefined ? {} : { reporterId }),
    ...(moduleId === undefined ? {} : { moduleId }),
    ...(severityValue === undefined ? {} : { severity: severityValue as MobileBugSeverity }),
    ...(priorityValue === undefined ? {} : { priority: priorityValue as MobileBugPriority }),
    ...(updatedAfter === undefined ? {} : { updatedAfter }),
    ...(sortValue === undefined ? {} : { sort: sortValue as MobileBugListSort }),
    ...(cursor === undefined ? {} : { cursor }),
    limit,
  };
}

const UPDATE_KEYS = new Set([
  "expectedVersion",
  "title",
  "description",
  "expectedBehavior",
  "moduleId",
  "severity",
  "priority",
  "ownerId",
  "verificationOwnerId",
  "attachmentIds",
]);

function positiveInteger(value: unknown, key: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${key} must be a positive integer`);
  }
  return value as number;
}

function updateString(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || candidate.length < minimum || candidate.length > maximum) {
    throw new TypeError(`${key} must be a bounded string`);
  }
  return candidate;
}

function updateOptionalUuid(
  value: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const candidate = value[key];
  if (candidate === undefined || candidate === null) return candidate;
  if (typeof candidate !== "string") throw new TypeError(`${key} must be null or a UUID`);
  return requireUuid(candidate, key);
}

export function parseMobileUpdateBugRequest(value: unknown): MobileUpdateBugRequest {
  const request = requireRecord(value, "updateBug request");
  requireOnlyKeys(request, UPDATE_KEYS);
  const expectedVersion = positiveInteger(request["expectedVersion"], "expectedVersion");
  if (!Object.keys(request).some((key) => key !== "expectedVersion")) {
    throw new TypeError("updateBug request must contain at least one mutable field");
  }
  const title = updateString(request, "title", 1, 300);
  const description = updateString(request, "description", 1, 20_000);
  const expectedBehavior = updateString(request, "expectedBehavior", 1, 10_000);
  const moduleId = updateOptionalUuid(request, "moduleId");
  const ownerId = updateOptionalUuid(request, "ownerId");
  const verificationOwnerId = updateOptionalUuid(request, "verificationOwnerId");
  const severityValue = request["severity"];
  if (
    severityValue !== undefined &&
    (typeof severityValue !== "string" || !SEVERITIES.has(severityValue as MobileBugSeverity))
  ) {
    throw new TypeError("severity is unsupported");
  }
  const priorityValue = request["priority"];
  if (
    priorityValue !== undefined &&
    (typeof priorityValue !== "string" || !PRIORITIES.has(priorityValue as MobileBugPriority))
  ) {
    throw new TypeError("priority is unsupported");
  }
  const attachmentValue = request["attachmentIds"];
  let attachmentIds: readonly string[] | undefined;
  if (attachmentValue !== undefined) {
    if (!Array.isArray(attachmentValue) || attachmentValue.length > 20) {
      throw new TypeError("attachmentIds must contain at most 20 UUIDs");
    }
    attachmentIds = attachmentValue.map((attachmentId) => {
      if (typeof attachmentId !== "string") throw new TypeError("attachmentId must be a UUID");
      return requireUuid(attachmentId, "attachmentId");
    });
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      throw new TypeError("attachmentIds must be unique");
    }
  }
  return {
    expectedVersion,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(expectedBehavior === undefined ? {} : { expectedBehavior }),
    ...(moduleId === undefined ? {} : { moduleId }),
    ...(severityValue === undefined ? {} : { severity: severityValue as MobileBugSeverity }),
    ...(priorityValue === undefined ? {} : { priority: priorityValue as MobileBugPriority }),
    ...(ownerId === undefined ? {} : { ownerId }),
    ...(verificationOwnerId === undefined ? {} : { verificationOwnerId }),
    ...(attachmentIds === undefined ? {} : { attachmentIds }),
  };
}

function requireString(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length < minimum || candidate.length > maximum) {
    throw new TypeError(`${key} must be a bounded string`);
  }
  return candidate;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  maximum: number,
): string | null | undefined {
  const candidate = value[key];
  if (candidate === undefined || candidate === null) return candidate;
  if (typeof candidate !== "string" || candidate.length > maximum) {
    throw new TypeError(`${key} must be null or a bounded string`);
  }
  return candidate;
}

function requireUuid(value: string, key: string): string {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${key} must be a UUID`);
  return value;
}

function optionalUuid(value: Record<string, unknown>, key: string): string | null | undefined {
  const candidate = value[key];
  if (candidate === undefined || candidate === null) return candidate;
  if (typeof candidate !== "string") throw new TypeError(`${key} must be null or a UUID`);
  return requireUuid(candidate, key);
}

function parseEnvironment(
  value: unknown,
): Readonly<Record<string, MobileOccurrenceEnvironmentValue>> {
  const environment = requireRecord(value, "occurrence.environment");
  requireOnlyKeys(environment, ENVIRONMENT_KEYS);
  for (const [key, entry] of Object.entries(environment)) {
    if (
      entry !== null &&
      typeof entry !== "string" &&
      typeof entry !== "number" &&
      typeof entry !== "boolean"
    ) {
      throw new TypeError(`occurrence.environment.${key} must be a scalar`);
    }
  }
  return { ...environment } as Readonly<Record<string, MobileOccurrenceEnvironmentValue>>;
}

function parseOccurrence(value: unknown): MobileOccurrenceDraft {
  const occurrence = requireRecord(value, "occurrence");
  requireOnlyKeys(occurrence, OCCURRENCE_KEYS);
  const observedAt = requireString(occurrence, "observedAt", 20, 100);
  if (!Number.isFinite(Date.parse(observedAt)))
    throw new TypeError("observedAt must be a date-time");
  const platform = requireString(occurrence, "platform", 1, 20) as MobileOccurrencePlatform;
  if (!PLATFORMS.has(platform)) throw new TypeError("platform is unsupported");
  const stepsValue = occurrence["steps"];
  if (!Array.isArray(stepsValue) || stepsValue.length < 1 || stepsValue.length > 50) {
    throw new TypeError("steps must contain from 1 through 50 entries");
  }
  const steps = stepsValue.map((step) => {
    if (typeof step !== "string" || step.length < 1 || step.length > 1_000) {
      throw new TypeError("each step must be a bounded string");
    }
    return step;
  });
  const gitSha = optionalString(occurrence, "gitSha", 40);
  if (typeof gitSha === "string" && !GIT_SHA_PATTERN.test(gitSha)) {
    throw new TypeError("gitSha must be a lowercase Git SHA");
  }
  const appVersion = optionalString(occurrence, "appVersion", 100);
  const resourceVersion = optionalString(occurrence, "resourceVersion", 100);
  const deviceModel = optionalString(occurrence, "deviceModel", 200);
  const osVersion = optionalString(occurrence, "osVersion", 100);
  const frequency = optionalString(occurrence, "frequency", 100);
  const errorSignature = optionalString(occurrence, "errorSignature", 500);
  const environmentValue = occurrence["environment"];
  return {
    observedAt,
    platform,
    ...(appVersion === undefined ? {} : { appVersion }),
    ...(resourceVersion === undefined ? {} : { resourceVersion }),
    ...(gitSha === undefined ? {} : { gitSha }),
    ...(deviceModel === undefined ? {} : { deviceModel }),
    ...(osVersion === undefined ? {} : { osVersion }),
    steps,
    actualBehavior: requireString(occurrence, "actualBehavior", 1, 10_000),
    ...(frequency === undefined ? {} : { frequency }),
    ...(errorSignature === undefined ? {} : { errorSignature }),
    ...(environmentValue === undefined ? {} : { environment: parseEnvironment(environmentValue) }),
  };
}

export function parseMobileCreateBugRequest(value: unknown): MobileCreateBugRequest {
  const request = requireRecord(value, "createBug request");
  requireOnlyKeys(request, CREATE_KEYS);
  const contractVersion = requireString(request, "submissionContractVersion", 1, 20);
  if (contractVersion !== "1.1.0") {
    throw new TypeError("submissionContractVersion must be 1.1.0");
  }
  const severity = requireString(request, "severity", 2, 2) as MobileBugSeverity;
  if (!SEVERITIES.has(severity)) throw new TypeError("severity is unsupported");
  const priority = requireString(request, "priority", 2, 2) as MobileBugPriority;
  if (!PRIORITIES.has(priority)) throw new TypeError("priority is unsupported");
  const attachmentValue = request["attachmentIds"];
  let attachmentIds: readonly string[] | undefined;
  if (attachmentValue !== undefined) {
    if (!Array.isArray(attachmentValue) || attachmentValue.length > 20) {
      throw new TypeError("attachmentIds must contain at most 20 UUIDs");
    }
    attachmentIds = attachmentValue.map((attachmentId) => {
      if (typeof attachmentId !== "string") throw new TypeError("attachmentId must be a UUID");
      return requireUuid(attachmentId, "attachmentId");
    });
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      throw new TypeError("attachmentIds must be unique");
    }
  }
  const moduleId = optionalUuid(request, "moduleId");
  const ownerId = optionalUuid(request, "ownerId");
  const verificationOwnerId = optionalUuid(request, "verificationOwnerId");
  const captureBundleId = optionalUuid(request, "captureBundleId");
  return {
    submissionContractVersion: "1.1.0",
    projectId: requireUuid(requireString(request, "projectId", 36, 36), "projectId"),
    clientSubmissionId: requireUuid(
      requireString(request, "clientSubmissionId", 36, 36),
      "clientSubmissionId",
    ),
    title: requireString(request, "title", 1, 300),
    description: requireString(request, "description", 1, 20_000),
    expectedBehavior: requireString(request, "expectedBehavior", 1, 10_000),
    ...(moduleId === undefined ? {} : { moduleId }),
    ...(ownerId === undefined ? {} : { ownerId }),
    ...(verificationOwnerId === undefined ? {} : { verificationOwnerId }),
    severity,
    priority,
    occurrence: parseOccurrence(request["occurrence"]),
    ...(attachmentIds === undefined ? {} : { attachmentIds }),
    ...(captureBundleId === undefined ? {} : { captureBundleId }),
  };
}
