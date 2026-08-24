/** Version of the public contracts this domain vocabulary mirrors. */
export const CONTRACT_VERSION = "1.0.0" as const;

/** Version of this independently deployable domain package. */
export const DOMAIN_VERSION = "0.1.0-debug" as const;

export const BUG_STATES = Object.freeze([
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
] as const);

export type BugState = (typeof BUG_STATES)[number];

export const REPAIR_MODES = Object.freeze(["human", "relay", "external"] as const);

export type RepairMode = (typeof REPAIR_MODES)[number];

export const REPAIR_STATUSES = Object.freeze([
  "planned",
  "queued",
  "running",
  "needs_input",
  "blocked",
  "delivered",
  "failed",
  "verification_failed",
  "cancelled",
  "superseded",
] as const);

export type RepairStatus = (typeof REPAIR_STATUSES)[number];

export const VERIFICATION_STATUSES = Object.freeze([
  "requested",
  "in_progress",
  "passed",
  "failed",
  "blocked",
  "cancelled",
] as const);

export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const SEVERITIES = Object.freeze(["S0", "S1", "S2", "S3", "S4"] as const);

export type Severity = (typeof SEVERITIES)[number];

export const PRIORITIES = Object.freeze(["P0", "P1", "P2", "P3", "P4"] as const);

export type Priority = (typeof PRIORITIES)[number];

export const ACTOR_TYPES = Object.freeze(["user", "service", "system"] as const);

export type ActorType = (typeof ACTOR_TYPES)[number];

export const TERMINAL_BUG_STATES = Object.freeze([
  "closed",
  "deferred",
  "rejected",
  "duplicate",
] as const satisfies readonly BugState[]);

/**
 * Targets an integration may project without making a human verification
 * decision. In particular, Relay can never close, reject, or deduplicate a Bug.
 */
export const RELAY_AUTOMATION_TARGET_STATES = Object.freeze([
  "ready",
  "in_progress",
  "awaiting_build",
  "ready_for_verification",
] as const satisfies readonly BugState[]);

function contains<const T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

export function isBugState(value: string): value is BugState {
  return contains(BUG_STATES, value);
}

export function isRepairMode(value: string): value is RepairMode {
  return contains(REPAIR_MODES, value);
}

export function isRepairStatus(value: string): value is RepairStatus {
  return contains(REPAIR_STATUSES, value);
}

export function isVerificationStatus(value: string): value is VerificationStatus {
  return contains(VERIFICATION_STATUSES, value);
}

export function isTerminalBugState(state: BugState): boolean {
  return contains(TERMINAL_BUG_STATES, state);
}

export function isRelayAutomationTargetState(state: BugState): boolean {
  return contains(RELAY_AUTOMATION_TARGET_STATES, state);
}
