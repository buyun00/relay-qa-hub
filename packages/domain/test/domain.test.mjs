import assert from "node:assert/strict";
import test from "node:test";

import {
  BUG_STATES,
  CONTRACT_VERSION,
  RELAY_AUTOMATION_TARGET_STATES,
  isBugState,
  isRelayAutomationTargetState,
  isRepairStatus,
  isTerminalBugState,
} from "../dist/index.js";

test("exports the frozen contract vocabulary", () => {
  assert.equal(CONTRACT_VERSION, "1.0.0");
  assert.equal(BUG_STATES.length, 10);
  assert.equal(isBugState("ready_for_verification"), true);
  assert.equal(isBugState("fixed"), false);
  assert.equal(isRepairStatus("verification_failed"), true);
});

test("keeps acceptance and closure human-owned", () => {
  assert.deepEqual(RELAY_AUTOMATION_TARGET_STATES, [
    "ready",
    "in_progress",
    "awaiting_build",
    "ready_for_verification",
  ]);
  assert.equal(isRelayAutomationTargetState("closed"), false);
  assert.equal(isRelayAutomationTargetState("rejected"), false);
  assert.equal(isRelayAutomationTargetState("duplicate"), false);
  assert.equal(isTerminalBugState("closed"), true);
  assert.equal(isTerminalBugState("ready_for_verification"), false);
});

test("runtime consumers cannot mutate Relay authority into acceptance", () => {
  assert.equal(Object.isFrozen(RELAY_AUTOMATION_TARGET_STATES), true);
  assert.throws(() => RELAY_AUTOMATION_TARGET_STATES.push("closed"), TypeError);
  assert.throws(() => {
    RELAY_AUTOMATION_TARGET_STATES[0] = "closed";
  }, TypeError);
  assert.equal(isRelayAutomationTargetState("closed"), false);
});
