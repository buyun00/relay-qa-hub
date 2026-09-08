// Legacy modes remain readable for existing jobs; new jobs expose only the last two.
export type UploadMode = "upload_only" | "prepare_test" | "publish_workflow" | "prepare_publish";
export const DEFAULT_UPLOAD_PARAMETERS = {
  productId: "2002",
  channelId: "1002",
  belongName: "[2002]Baloot Go|[1002]谷歌-国际正式",
  testerId: 11562,
} as const;
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
export interface UploadEvent {
  at: string;
  stage: string;
  kind: string;
  code: string;
  completedBytes: number;
  totalBytes: number;
  completedParts: number;
  totalParts: number;
}
export interface UploadJob {
  id: string;
  createdAt: string;
  input: UploadInput;
  active: boolean;
  stage: string;
  status: "running" | "succeeded" | "failed" | "interrupted" | "awaiting_test" | "awaiting_publish";
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
  openFolder: (id: string) => Promise<UploadReply<boolean>>;
  confirmPublish: (id: string) => Promise<UploadReply<string>>;
}
