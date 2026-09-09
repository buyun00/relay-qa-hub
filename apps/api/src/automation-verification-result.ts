import { parseMobileRecordVerificationResultRequest } from "./mobile-verification.js";

const uuid = { type: "string", pattern: "^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$" };
const reason = { type: "string", minLength: 1, maxLength: 5_000 };

/** Shared by JSON-RPC discovery and the desktop's dynamically fetched API catalog. */
export const VERIFICATION_RESULT_AUTOMATION_TOOL = {
  name: "qa_record_verification_result",
  title: "提交指派验收人的验收结论",
  description:
    "调用冻结的1.1验收结果HTTP入口，提交passed、failed或blocked。必须提供原客户端clientSubmissionId和Verification expectedVersion；使用当前项目会话并在首写及重放时重验指派验收人权限。幂等键可省略以派生canonical键，显式值必须一致。blocked保留已交付修复轮次，可另建验收。返回原始冻结DTO，不代表外部任务已执行。",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["projectId", "verificationId", "request"],
    properties: {
      projectId: uuid,
      verificationId: uuid,
      idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
      request: {
        type: "object",
        additionalProperties: false,
        required: [
          "submissionContractVersion",
          "clientSubmissionId",
          "expectedVersion",
          "status",
          "resultSummary",
          "attachmentIds",
        ],
        properties: {
          submissionContractVersion: { const: "1.1.0" },
          clientSubmissionId: uuid,
          expectedVersion: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          status: { enum: ["passed", "failed", "blocked"] },
          resultSummary: { type: "string", minLength: 1, maxLength: 10_000 },
          attachmentIds: { type: "array", maxItems: 20, uniqueItems: true, items: uuid },
          captureBundleId: { anyOf: [uuid, { type: "null" }] },
          failureReason: reason,
          blockedReason: reason,
        },
        oneOf: [
          {
            properties: { status: { const: "passed" } },
            not: { anyOf: [{ required: ["failureReason"] }, { required: ["blockedReason"] }] },
          },
          {
            properties: { status: { const: "failed" } },
            required: ["failureReason"],
            not: { required: ["blockedReason"] },
          },
          {
            properties: { status: { const: "blocked" } },
            required: ["blockedReason"],
            not: { required: ["failureReason"] },
          },
        ],
      },
    },
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const;

/** Build only the fixed authenticated HTTP request; never infer a client submission identity. */
export function verificationResultAutomationRequest(input: Record<string, unknown>): {
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly idempotencyKey: string;
} {
  const allowed = new Set(["projectId", "verificationId", "request", "idempotencyKey"]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new TypeError("Unexpected Verification tool argument");
  for (const key of ["projectId", "verificationId"] as const) {
    if (typeof input[key] !== "string" || !new RegExp(uuid.pattern, "u").test(input[key]))
      throw new TypeError("Verification tool requires explicit UUID scope");
  }
  const body = parseMobileRecordVerificationResultRequest(input["request"]);
  const idempotencyKey = `workflow:recordVerificationResult:verification:${input["verificationId"]}:v${body.expectedVersion}`;
  if (input["idempotencyKey"] !== undefined && input["idempotencyKey"] !== idempotencyKey)
    throw new TypeError("Verification result key must match its target and version");
  return {
    path: `/api/v1/verifications/${encodeURIComponent(input["verificationId"] as string)}/result`,
    body: { ...body },
    idempotencyKey,
  };
}
