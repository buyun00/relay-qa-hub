// Legacy modes remain readable for existing jobs; new jobs expose only the last two.
export type UploadMode = "upload_only" | "prepare_test" | "publish_workflow" | "prepare_publish";
export type UploadPlatform = "android" | "ios";
export declare const UPLOAD_TARGETS: Readonly<
  Record<
    UploadPlatform,
    Readonly<{
      label: string;
      channelId: string;
      channelName: string;
      sourceUrl: string;
    }>
  >
>;
export declare const DEFAULT_UPLOAD_PARAMETERS: {
  readonly productId: "2002";
  readonly channelId: "1002";
  readonly belongName: "[2002]Baloot Go|[1002]谷歌-国际正式";
  readonly testerId: 11562;
};
export interface UploadInput {
  productId: string;
  channelId: string;
  belongName: string;
  version: string;
  summary: string;
  description: string;
  mode: UploadMode;
  testerId: number;
  testResultReference: string;
}
export interface UploadLogin {
  account: string;
  password: string;
  kind: "email" | "subaccount";
}
export interface UploadSourceIdentity {
  size: number;
  lastModified: string;
}
export interface BuildUploadChain {
  id: string;
  ownerId: string;
  accountIdentity: string;
  createdAt: string;
  updatedAt: string;
  input: UploadInput;
  queueId: number | null;
  buildNumber: number | null;
  status:
    | "queued"
    | "submitting"
    | "submission_unknown"
    | "building"
    | "waiting_zip"
    | "starting_upload"
    | "upload_started"
    | "failed"
    | "cancelled";
  errorCode: string;
  uploadJobId: string | null;
  baseline: UploadSourceIdentity | null;
  source: UploadSourceIdentity | null;
}
export interface UploadEvent {
  at: string;
  stage: string;
  kind: string;
  code: string;
  completedBytes: number;
  totalBytes: number;
  completedParts: number;
  totalParts: number;
  concurrency?: number;
}
export interface UploadJob {
  id: string;
  createdAt: string;
  input: UploadInput;
  sourceUrl?: string;
  sourceFileName?: string;
  active: boolean;
  stage: string;
  queuePosition?: number;
  blockedBy?: string;
  status:
    | "queued"
    | "cancelled"
    | "running"
    | "succeeded"
    | "failed"
    | "interrupted"
    | "awaiting_test"
    | "awaiting_publish";
  recordedWorkflow?: boolean;
  errorCode: string;
  version: string;
  versionId: number;
  sha256: string;
  size: number;
  done: string[];
  testResultLocked: boolean;
  pendingAction: string;
  published: boolean;
  publishTime: string;
  remoteStatus: number;
  events: UploadEvent[];
}
export interface UploaderSnapshot {
  execution?: "server";
  available: boolean;
  toolVersion: string;
  sourceUrl: string;
  account: string;
  kind: "email" | "subaccount";
  configured: boolean;
  authError: boolean;
  jobs: UploadJob[];
  unreadableJobs: number;
}
export type UploadReply<T> = { ok: true; value: T } | { ok: false; code: string };
export interface UploaderBridge {
  snapshot: () => Promise<UploadReply<UploaderSnapshot>>;
  login: (input: UploadLogin) => Promise<UploadReply<boolean>>;
  checkAuth: () => Promise<UploadReply<boolean>>;
  logout: () => Promise<UploadReply<boolean>>;
  start: (input: UploadInput) => Promise<UploadReply<string>>;
  resume: (input: {
    id: string;
    testerId: number;
    testResultReference: string;
  }) => Promise<UploadReply<string>>;
  cancel?: (id: string) => Promise<UploadReply<boolean>>;
  openFolder: (id: string) => Promise<UploadReply<boolean>>;
  confirmPublish: (id: string) => Promise<UploadReply<string>>;
  buildChains: () => Promise<UploadReply<BuildUploadChain[]>>;
  buildAndUpload: (input: {
    requestId: string;
    upload: UploadInput;
  }) => Promise<UploadReply<BuildUploadChain>>;
  cancelBuildUpload: (id: string) => Promise<UploadReply<boolean>>;
}
