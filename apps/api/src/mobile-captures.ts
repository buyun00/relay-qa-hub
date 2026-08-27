import {
  MOBILE_CAPTURE_ALLOWED_METHODS,
  type MobileCaptureArtifactKind,
  type MobileCaptureArtifactStatus,
  type MobileCaptureBundleRecord,
  type MobileCaptureDeviceMetadata,
  type MobileCapturePocoInput,
  type MobileCapturePocoMethod,
  type MobileCaptureScreenSize,
  type MobileCaptureCreation,
} from "@relay-qa-hub/storage";

export const MOBILE_CAPTURE_COLLECTION_PATH = "/api/v1/capture-bundles" as const;
export const MOBILE_CAPTURE_ITEM_PATH = "/api/v1/capture-bundles/:captureId" as const;

export type MobileCaptureSource =
  | "overlay_single_tap"
  | "overlay_double_tap"
  | "recording_marker"
  | "recording_stop"
  | "android_share"
  | "photo_picker";

export interface MobileCaptureArtifactRequest {
  readonly captureId: string;
  readonly clientAttachmentId: string | null;
  readonly attachmentId: string | null;
  readonly kind: MobileCaptureArtifactKind;
  readonly status: MobileCaptureArtifactStatus;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly skewMs: number;
  readonly truncated: boolean;
  readonly failureReason: string | null;
}

export interface MobileCaptureRequest {
  readonly submissionContractVersion: "1.1.0";
  readonly projectId: string;
  readonly clientSubmissionId: string;
  readonly capture: {
    readonly captureId: string;
    readonly clientSubmissionId: string;
    readonly projectId: string;
    readonly capturedAt: string;
    readonly source: MobileCaptureSource;
    readonly primaryEvidenceClientAttachmentId: string;
    readonly primaryEvidenceAttachmentId: string;
    readonly artifacts: readonly MobileCaptureArtifactRequest[];
    readonly poco: MobileCapturePocoInput;
    readonly deviceMetadata: MobileCaptureDeviceMetadata;
  };
}

export interface MobileCreateCaptureResponse {
  readonly captureBundle: MobileCaptureBundleRecord;
  readonly replayed: boolean;
}

export interface CreateMobileCaptureCommand {
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly request: MobileCaptureRequest;
}

export interface GetMobileCaptureQuery {
  readonly actorId: string;
  readonly captureId: string;
}

export interface MobileCaptureStore {
  readonly createCapture: (
    command: CreateMobileCaptureCommand,
  ) => MobileCreateCaptureResponse | Promise<MobileCreateCaptureResponse>;
  readonly getCapture: (
    query: GetMobileCaptureQuery,
  ) => MobileCaptureBundleRecord | null | Promise<MobileCaptureBundleRecord | null>;
}

export class MobileCaptureRequestError extends TypeError {
  readonly code: "CAPTURE_BUNDLE_INVALID" | "INVALID_REQUEST";

  constructor(
    message: string,
    code: "CAPTURE_BUNDLE_INVALID" | "INVALID_REQUEST" = "INVALID_REQUEST",
  ) {
    super(message);
    this.name = "MobileCaptureRequestError";
    this.code = code;
  }
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
const CAPTURE_KEYS = new Set([
  "captureId",
  "clientSubmissionId",
  "projectId",
  "capturedAt",
  "source",
  "primaryEvidenceClientAttachmentId",
  "primaryEvidenceAttachmentId",
  "artifacts",
  "poco",
  "deviceMetadata",
]);
const CREATE_KEYS = new Set([
  "submissionContractVersion",
  "projectId",
  "clientSubmissionId",
  "capture",
]);
const ARTIFACT_KEYS = new Set([
  "captureId",
  "clientAttachmentId",
  "attachmentId",
  "kind",
  "status",
  "startedAt",
  "endedAt",
  "skewMs",
  "truncated",
  "failureReason",
]);
const POCO_KEYS = new Set([
  "attempted",
  "connectedPort",
  "sdkVersion",
  "snapshotCapability",
  "screenSize",
  "allowedReadOnlyMethods",
  "negotiatedMethods",
  "succeededMethods",
  "failureReason",
]);
const DEVICE_KEYS = new Set([
  "manufacturer",
  "model",
  "androidApi",
  "androidRelease",
  "qaAppVersion",
  "buildId",
  "testSessionId",
  "networkType",
]);
const SOURCES = new Set<MobileCaptureSource>([
  "overlay_single_tap",
  "overlay_double_tap",
  "recording_marker",
  "recording_stop",
  "android_share",
  "photo_picker",
]);
const ARTIFACT_KINDS = new Set<MobileCaptureArtifactKind>([
  "system_screenshot",
  "system_recording",
  "poco_screenshot",
  "poco_hierarchy",
  "poco_profiling",
  "poco_snapshot",
]);
const ARTIFACT_STATUSES = new Set<MobileCaptureArtifactStatus>(["succeeded", "failed", "skipped"]);
const FAILURE_REASONS = new Set([
  "not_running",
  "connection_refused",
  "timeout",
  "cancelled",
  "invalid_frame",
  "oversized_response",
  "unsupported_version",
  "unity_stopped",
  "unknown",
]);
const NETWORK_TYPES = new Set(["offline", "wifi", "cellular", "ethernet", "vpn", "other"]);

function requireRecord(
  value: unknown,
  label: string,
  code = "INVALID_REQUEST",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MobileCaptureRequestError(`${label} must be an object`, code as "INVALID_REQUEST");
  }
  return value as Record<string, unknown>;
}

function requireOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  code = "INVALID_REQUEST",
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new MobileCaptureRequestError(`unexpected property: ${key}`, code as "INVALID_REQUEST");
  }
}

function invalidCapture(message: string): never {
  throw new MobileCaptureRequestError(message, "CAPTURE_BUNDLE_INVALID");
}

function requireString(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length < minimum || candidate.length > maximum) {
    throw new MobileCaptureRequestError(`${key} must be a bounded string`);
  }
  return candidate;
}

function requireUuid(value: unknown, key: string, code = "INVALID_REQUEST"): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new MobileCaptureRequestError(`${key} must be a UUID`, code as "INVALID_REQUEST");
  }
  return value;
}

function optionalUuid(value: Record<string, unknown>, key: string): string | null | undefined {
  const candidate = value[key];
  if (candidate === undefined || candidate === null) return candidate;
  return requireUuid(candidate, key, "CAPTURE_BUNDLE_INVALID");
}

function requireDateTime(value: Record<string, unknown>, key: string): string {
  const candidate = requireString(value, key, 20, 100);
  if (!Number.isFinite(Date.parse(candidate))) invalidCapture(`${key} must be a date-time`);
  return candidate;
}

function parseScreenSize(value: unknown): MobileCaptureScreenSize | null {
  if (value === null) return null;
  const screen = requireRecord(value, "poco.screenSize", "CAPTURE_BUNDLE_INVALID");
  requireOnlyKeys(screen, new Set(["width", "height"]), "CAPTURE_BUNDLE_INVALID");
  const width = screen["width"];
  const height = screen["height"];
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    (width as number) < 1 ||
    (width as number) > 32768 ||
    (height as number) < 1 ||
    (height as number) > 32768
  ) {
    invalidCapture("poco.screenSize is invalid");
  }
  return { width: width as number, height: height as number };
}

function parsePocoMethodArray(value: unknown, key: string): readonly MobileCapturePocoMethod[] {
  if (!Array.isArray(value) || value.length > MOBILE_CAPTURE_ALLOWED_METHODS.length) {
    invalidCapture(`${key} must contain at most six methods`);
  }
  const methods = value.map((candidate) => {
    if (
      typeof candidate !== "string" ||
      !MOBILE_CAPTURE_ALLOWED_METHODS.includes(candidate as MobileCapturePocoMethod)
    ) {
      invalidCapture(`${key} contains an unsupported method`);
    }
    return candidate as MobileCapturePocoMethod;
  });
  if (new Set(methods).size !== methods.length) invalidCapture(`${key} must be unique`);
  return methods;
}

function hasSameSet(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value) => second.includes(value));
}

function parsePoco(value: unknown): MobileCapturePocoInput {
  const poco = requireRecord(value, "capture.poco", "CAPTURE_BUNDLE_INVALID");
  requireOnlyKeys(poco, POCO_KEYS, "CAPTURE_BUNDLE_INVALID");
  if (typeof poco["attempted"] !== "boolean") invalidCapture("poco.attempted must be boolean");
  const connectedPort = poco["connectedPort"];
  if (
    connectedPort !== null &&
    (!Number.isInteger(connectedPort) ||
      (connectedPort as number) < 1 ||
      (connectedPort as number) > 65535)
  ) {
    invalidCapture("poco.connectedPort is invalid");
  }
  const sdkVersion = poco["sdkVersion"];
  if (
    sdkVersion !== null &&
    (typeof sdkVersion !== "string" || sdkVersion.length < 1 || sdkVersion.length > 100)
  ) {
    invalidCapture("poco.sdkVersion is invalid");
  }
  const snapshotCapability = poco["snapshotCapability"];
  if (
    !new Set(["not_probed", "standard_only", "qa_snapshot_available"]).has(
      snapshotCapability as string,
    )
  ) {
    invalidCapture("poco.snapshotCapability is invalid");
  }
  const allowed = poco["allowedReadOnlyMethods"];
  if (
    !Array.isArray(allowed) ||
    allowed.length !== MOBILE_CAPTURE_ALLOWED_METHODS.length ||
    allowed.some((method, index) => method !== MOBILE_CAPTURE_ALLOWED_METHODS[index])
  ) {
    invalidCapture("poco.allowedReadOnlyMethods must use the frozen allowlist");
  }
  const negotiatedMethods = parsePocoMethodArray(
    poco["negotiatedMethods"],
    "poco.negotiatedMethods",
  );
  const succeededMethods = parsePocoMethodArray(poco["succeededMethods"], "poco.succeededMethods");
  const failureReason = poco["failureReason"];
  if (
    failureReason !== null &&
    (typeof failureReason !== "string" || !FAILURE_REASONS.has(failureReason))
  ) {
    invalidCapture("poco.failureReason is invalid");
  }
  const screenSize = parseScreenSize(poco["screenSize"]);
  for (const method of succeededMethods) {
    if (!negotiatedMethods.includes(method))
      invalidCapture("succeeded Poco methods must be negotiated");
  }
  if (!poco["attempted"]) {
    if (
      negotiatedMethods.length !== 0 ||
      succeededMethods.length !== 0 ||
      connectedPort !== null ||
      sdkVersion !== null ||
      snapshotCapability !== "not_probed" ||
      screenSize !== null ||
      failureReason !== null
    )
      invalidCapture("an unattempted Poco enrichment must be effect-free");
  } else {
    if (
      negotiatedMethods.some((method) => method !== "GetSDKVersion") &&
      !succeededMethods.includes("GetSDKVersion")
    ) {
      invalidCapture("negotiated Poco methods require GetSDKVersion");
    }
    if (succeededMethods.length > 0 && !succeededMethods.includes("GetSDKVersion")) {
      invalidCapture("succeeded Poco methods require GetSDKVersion");
    }
    if ((connectedPort !== null) !== succeededMethods.includes("GetSDKVersion")) {
      invalidCapture("connectedPort does not match GetSDKVersion");
    }
    if ((sdkVersion !== null) !== succeededMethods.includes("GetSDKVersion")) {
      invalidCapture("sdkVersion does not match GetSDKVersion");
    }
    if ((screenSize !== null) !== succeededMethods.includes("GetScreenSize")) {
      invalidCapture("screenSize does not match GetScreenSize");
    }
    if (
      (snapshotCapability === "qa_snapshot_available") !==
      negotiatedMethods.includes("qa.snapshot")
    ) {
      invalidCapture("snapshotCapability does not match qa.snapshot negotiation");
    }
    if (
      snapshotCapability === "standard_only" &&
      (!succeededMethods.includes("GetSDKVersion") || negotiatedMethods.includes("qa.snapshot"))
    ) {
      invalidCapture("standard_only requires SDK success without qa.snapshot");
    }
    if (snapshotCapability === "not_probed" && succeededMethods.includes("GetSDKVersion")) {
      invalidCapture("not_probed cannot include SDK success");
    }
    if (
      negotiatedMethods.length > 0 &&
      hasSameSet(negotiatedMethods, succeededMethods) &&
      failureReason !== null
    ) {
      invalidCapture("fully succeeded Poco methods cannot report a failure reason");
    }
  }
  return {
    attempted: poco["attempted"] as boolean,
    connectedPort: connectedPort as number | null,
    sdkVersion: sdkVersion as string | null,
    snapshotCapability: snapshotCapability as MobileCapturePocoInput["snapshotCapability"],
    screenSize,
    allowedReadOnlyMethods: MOBILE_CAPTURE_ALLOWED_METHODS,
    negotiatedMethods,
    succeededMethods,
    failureReason: failureReason as MobileCapturePocoInput["failureReason"],
  };
}

function parseDeviceMetadata(value: unknown): MobileCaptureDeviceMetadata {
  const device = requireRecord(value, "capture.deviceMetadata", "CAPTURE_BUNDLE_INVALID");
  requireOnlyKeys(device, DEVICE_KEYS, "CAPTURE_BUNDLE_INVALID");
  const androidApi = device["androidApi"];
  if (
    !Number.isInteger(androidApi) ||
    (androidApi as number) < 31 ||
    (androidApi as number) > 100
  ) {
    invalidCapture("deviceMetadata.androidApi is invalid");
  }
  const networkType = device["networkType"];
  if (typeof networkType !== "string" || !NETWORK_TYPES.has(networkType)) {
    invalidCapture("deviceMetadata.networkType is invalid");
  }
  const buildId = optionalUuid(device, "buildId");
  const testSessionId = device["testSessionId"];
  if (
    testSessionId !== undefined &&
    testSessionId !== null &&
    (typeof testSessionId !== "string" || testSessionId.length > 200)
  ) {
    invalidCapture("deviceMetadata.testSessionId is invalid");
  }
  return {
    manufacturer: requireString(device, "manufacturer", 1, 100),
    model: requireString(device, "model", 1, 200),
    androidApi: androidApi as number,
    androidRelease: requireString(device, "androidRelease", 1, 100),
    qaAppVersion: requireString(device, "qaAppVersion", 1, 100),
    ...(buildId === undefined ? {} : { buildId }),
    ...(testSessionId === undefined ? {} : { testSessionId: testSessionId as string | null }),
    networkType: networkType as MobileCaptureDeviceMetadata["networkType"],
  };
}

function parseArtifact(value: unknown, captureId: string): MobileCaptureArtifactRequest {
  const artifact = requireRecord(value, "capture.artifact", "CAPTURE_BUNDLE_INVALID");
  requireOnlyKeys(artifact, ARTIFACT_KEYS, "CAPTURE_BUNDLE_INVALID");
  const artifactCaptureId = requireUuid(
    artifact["captureId"],
    "artifact.captureId",
    "CAPTURE_BUNDLE_INVALID",
  );
  if (artifactCaptureId !== captureId)
    invalidCapture("artifact.captureId must equal capture.captureId");
  const kind = artifact["kind"];
  if (typeof kind !== "string" || !ARTIFACT_KINDS.has(kind as MobileCaptureArtifactKind))
    invalidCapture("artifact.kind is invalid");
  const status = artifact["status"];
  if (typeof status !== "string" || !ARTIFACT_STATUSES.has(status as MobileCaptureArtifactStatus))
    invalidCapture("artifact.status is invalid");
  const clientAttachmentId = optionalUuid(artifact, "clientAttachmentId");
  const attachmentId = optionalUuid(artifact, "attachmentId");
  if (status === "succeeded") {
    if (!clientAttachmentId || !attachmentId) invalidCapture("succeeded artifact IDs are required");
    if (artifact["failureReason"] !== null)
      invalidCapture("succeeded artifact failureReason must be null");
  } else if (clientAttachmentId !== null || attachmentId !== null) {
    invalidCapture("failed or skipped artifacts must not claim attachment IDs");
  }
  const failureReason = artifact["failureReason"];
  if (
    failureReason !== null &&
    (typeof failureReason !== "string" || failureReason.length < 1 || failureReason.length > 300)
  ) {
    invalidCapture("artifact.failureReason is invalid");
  }
  if (status === "failed" && typeof failureReason !== "string")
    invalidCapture("failed artifact requires failureReason");
  const startedAt = requireDateTime(artifact, "startedAt");
  const endedAt = requireDateTime(artifact, "endedAt");
  if (Date.parse(endedAt) < Date.parse(startedAt))
    invalidCapture("artifact.endedAt precedes startedAt");
  const skewMs = artifact["skewMs"];
  if (!Number.isInteger(skewMs) || (skewMs as number) < 0 || (skewMs as number) > 5000)
    invalidCapture("artifact.skewMs is invalid");
  if (typeof artifact["truncated"] !== "boolean")
    invalidCapture("artifact.truncated must be boolean");
  return {
    captureId,
    clientAttachmentId: clientAttachmentId ?? null,
    attachmentId: attachmentId ?? null,
    kind: kind as MobileCaptureArtifactKind,
    status: status as MobileCaptureArtifactStatus,
    startedAt,
    endedAt,
    skewMs: skewMs as number,
    truncated: artifact["truncated"] as boolean,
    failureReason: failureReason as string | null,
  };
}

export function parseMobileCreateCaptureRequest(value: unknown): MobileCaptureRequest {
  const request = requireRecord(value, "createCapture request");
  requireOnlyKeys(request, CREATE_KEYS);
  if (requireString(request, "submissionContractVersion", 1, 20) !== "1.1.0") {
    throw new MobileCaptureRequestError("submissionContractVersion must be 1.1.0");
  }
  const projectId = requireUuid(request["projectId"], "projectId");
  const clientSubmissionId = requireUuid(request["clientSubmissionId"], "clientSubmissionId");
  const capture = requireRecord(request["capture"], "capture", "CAPTURE_BUNDLE_INVALID");
  requireOnlyKeys(capture, CAPTURE_KEYS, "CAPTURE_BUNDLE_INVALID");
  const captureId = requireUuid(
    capture["captureId"],
    "capture.captureId",
    "CAPTURE_BUNDLE_INVALID",
  );
  const nestedSubmissionId = requireUuid(
    capture["clientSubmissionId"],
    "capture.clientSubmissionId",
    "CAPTURE_BUNDLE_INVALID",
  );
  const nestedProjectId = requireUuid(
    capture["projectId"],
    "capture.projectId",
    "CAPTURE_BUNDLE_INVALID",
  );
  if (nestedSubmissionId !== clientSubmissionId)
    invalidCapture("capture.clientSubmissionId must equal the request clientSubmissionId");
  if (nestedProjectId !== projectId)
    invalidCapture("capture.projectId must equal the request projectId");
  const artifactsValue = capture["artifacts"];
  if (!Array.isArray(artifactsValue) || artifactsValue.length < 1 || artifactsValue.length > 12)
    invalidCapture("capture.artifacts must contain from 1 through 12 entries");
  const artifacts = artifactsValue.map((artifact) => parseArtifact(artifact, captureId));
  const kinds = new Set(artifacts.map((artifact) => artifact.kind));
  if (kinds.size !== artifacts.length) invalidCapture("capture artifact kinds must be unique");
  const primaryClientAttachmentId = requireUuid(
    capture["primaryEvidenceClientAttachmentId"],
    "capture.primaryEvidenceClientAttachmentId",
    "CAPTURE_BUNDLE_INVALID",
  );
  const primaryAttachmentId = requireUuid(
    capture["primaryEvidenceAttachmentId"],
    "capture.primaryEvidenceAttachmentId",
    "CAPTURE_BUNDLE_INVALID",
  );
  const primary = artifacts.find(
    (artifact) =>
      artifact.clientAttachmentId === primaryClientAttachmentId &&
      artifact.attachmentId === primaryAttachmentId,
  );
  if (
    !primary ||
    primary.status !== "succeeded" ||
    !["system_screenshot", "system_recording"].includes(primary.kind)
  )
    invalidCapture("primary evidence must be a succeeded system artifact");
  const capturedAt = requireDateTime(capture, "capturedAt");
  for (const artifact of artifacts) {
    const actualSkew = Math.abs(Date.parse(artifact.startedAt) - Date.parse(capturedAt));
    if (actualSkew > 5000 || Math.abs(artifact.skewMs - actualSkew) > 1)
      invalidCapture("artifact skewMs does not match capturedAt");
    const maxDuration = artifact.kind === "system_recording" ? 120_000 : 5_000;
    if (Date.parse(artifact.endedAt) - Date.parse(artifact.startedAt) > maxDuration)
      invalidCapture("artifact duration is too long");
  }
  const poco = parsePoco(capture["poco"]);
  const deviceMetadata = parseDeviceMetadata(capture["deviceMetadata"]);
  return {
    submissionContractVersion: "1.1.0",
    projectId,
    clientSubmissionId,
    capture: {
      captureId,
      clientSubmissionId: nestedSubmissionId,
      projectId: nestedProjectId,
      capturedAt,
      source: (() => {
        const source = capture["source"];
        if (typeof source !== "string" || !SOURCES.has(source as MobileCaptureSource))
          invalidCapture("capture.source is invalid");
        return source as MobileCaptureSource;
      })(),
      primaryEvidenceClientAttachmentId: primaryClientAttachmentId,
      primaryEvidenceAttachmentId: primaryAttachmentId,
      artifacts,
      poco,
      deviceMetadata,
    },
  };
}

export type { MobileCaptureCreation };
