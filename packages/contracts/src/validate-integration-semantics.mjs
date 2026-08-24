function readPath(value, dottedPath) {
  return dottedPath
    .split(".")
    .reduce(
      (current, segment) =>
        current && Object.prototype.hasOwnProperty.call(current, segment)
          ? current[segment]
          : undefined,
      value,
    );
}

export function validateIntegrationSemantics(
  event,
  invariants,
  context = {},
) {
  const violations = [];
  const matchingRules = invariants.rules.filter(
    (rule) => rule.eventType === event.eventType,
  );

  for (const rule of matchingRules) {
    for (const requiredPath of rule.requiredFields ?? []) {
      const value = readPath(event, requiredPath);
      if (value === undefined || value === null || value === "") {
        violations.push({
          ruleId: rule.id,
          errorCode: rule.errorCode,
          reason: `${requiredPath} is required`,
        });
      }
    }

    for (const requiredPath of rule.requiredTrue ?? []) {
      if (readPath(event, requiredPath) !== true) {
        violations.push({
          ruleId: rule.id,
          errorCode: rule.errorCode,
          reason: `${requiredPath} must be true`,
        });
      }
    }

    for (const [leftPath, rightPath] of rule.equalFields ?? []) {
      if (readPath(event, leftPath) !== readPath(event, rightPath)) {
        violations.push({
          ruleId: rule.id,
          errorCode: rule.errorCode,
          reason: `${leftPath} must equal ${rightPath}`,
        });
      }
    }

    for (const [eventPath, contextPath] of Object.entries(
      rule.compareToCurrentAttempt ?? {},
    )) {
      if (readPath(event, eventPath) !== readPath(context, contextPath)) {
        violations.push({
          ruleId: rule.id,
          errorCode: rule.errorCode,
          reason: `${eventPath} does not match ${contextPath}`,
        });
      }
    }

    if (rule.forbidBugTransitions && context.proposedBugTransition) {
      violations.push({
        ruleId: rule.id,
        errorCode: rule.errorCode,
        reason: `${event.eventType} cannot transition a QA Bug`,
      });
    }
  }

  return violations;
}
