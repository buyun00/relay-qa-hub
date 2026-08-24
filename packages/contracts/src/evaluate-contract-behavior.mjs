const machineForbiddenActions = new Set([
  "verification.passed",
  "bug.closed",
  "bug.rejected",
  "bug.deferred",
  "bug.duplicate",
]);

export function evaluateContractBehavior(kind, input) {
  switch (kind) {
    case "idempotency":
      return input.existingHash === input.incomingHash
        ? "replay"
        : "IDEMPOTENCY_PAYLOAD_MISMATCH";
    case "version":
      return input.currentVersion === input.expectedVersion
        ? "apply"
        : "VERSION_CONFLICT";
    case "machine-action":
      return machineForbiddenActions.has(input.action)
        ? "INTEGRATION_AUTOMATION_FORBIDDEN"
        : "allowed";
    case "build-identity": {
      const identityFields = [
        "provider",
        "externalId",
        "projectKey",
        "branch",
        "sourceCommitSha",
        "mode",
      ];
      return input.incoming.status === "ready" &&
        identityFields.every(
          (field) => input.incoming[field] === input.expected[field],
        )
        ? "eligible"
        : "BUILD_IDENTITY_MISMATCH";
    }
    case "integration-order":
      return input.currentMode === "relay" &&
        input.currentAttemptId === input.eventAttemptId &&
        input.eventRevision > input.currentRevision
        ? "apply"
        : "ignore";
    case "semantic-duplicate":
      return input.sameClientSubmissionId
        ? "transport_replay"
        : "candidate_only";
    case "notification":
      return "commit_with_inbox";
    case "relay-task-close":
      return "metadata_only";
    default:
      throw new Error(`Unknown contract behavior: ${kind}`);
  }
}
