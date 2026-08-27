const SENSITIVE_AUDIT_TEXT = [
  /authorization.*[:=]/iu,
  /bearer /iu,
  /password.*[:=]/iu,
  /passwd.*[:=]/iu,
  /pwd.*[:=]/iu,
  /secret.*[:=]/iu,
  /token.*[:=]/iu,
  /cookie.*[:=]/iu,
  /credential.*[:=]/iu,
  /apikey.*[:=]/iu,
  /api_key.*[:=]/iu,
  /api-key.*[:=]/iu,
  /api key.*[:=]/iu,
  /private.*key.*[:=]/iu,
  /:\/\/.*:.*@/u,
  /eyj.{8,}\..*\./iu,
  /\\/u,
] as const;

/**
 * Keep typed audit Events within the frozen 2 KB redaction policy while the
 * domain table retains the complete user-entered reason or summary.
 */
export function toBoundedAuditText(value: string, maximumBytes = 2_000): string {
  if (SENSITIVE_AUDIT_TEXT.some((pattern) => pattern.test(value))) return "[REDACTED]";
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const ellipsis = "…";
  let prefix = "";
  for (const character of value) {
    if (Buffer.byteLength(`${prefix}${character}${ellipsis}`, "utf8") > maximumBytes) break;
    prefix += character;
  }
  return `${prefix}${ellipsis}`;
}
