import type { UploadJob, UploadMode } from "@relay-qa-hub/upload-contract";
import {
  DEFAULT_UPLOAD_PARAMETERS,
  UPLOAD_TARGETS,
  type UploadInput,
  type UploadPlatform,
} from "@relay-qa-hub/upload-contract";

export const uploadPlatform = (input: Pick<UploadInput, "channelId">): UploadPlatform =>
  input.channelId === UPLOAD_TARGETS.ios.channelId ? "ios" : "android";

export function selectUploadPlatform(input: UploadInput, platform: UploadPlatform): UploadInput {
  const target = UPLOAD_TARGETS[platform];
  const productName = input.belongName.split("|")[0] || `[${input.productId}]Baloot Go`;
  return {
    ...input,
    channelId: target.channelId,
    belongName: `${productName}|[${target.channelId}]${target.channelName}`,
  };
}

export function uploadDraftDefaults(value: unknown): UploadInput {
  const draft =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<UploadInput> & { defaultsVersion?: number })
      : {};
  const version = typeof draft.version === "string" ? draft.version : "";
  return {
    ...DEFAULT_UPLOAD_PARAMETERS,
    productId:
      (typeof draft.productId === "string" && draft.productId.trim()) ||
      DEFAULT_UPLOAD_PARAMETERS.productId,
    channelId:
      (typeof draft.channelId === "string" && draft.channelId.trim()) ||
      DEFAULT_UPLOAD_PARAMETERS.channelId,
    belongName:
      (typeof draft.belongName === "string" && draft.belongName.trim()) ||
      DEFAULT_UPLOAD_PARAMETERS.belongName,
    testerId:
      Number.isSafeInteger(draft.testerId) &&
      Number(draft.testerId) > 0 &&
      (draft.testerId !== 1 || draft.defaultsVersion === 2)
        ? Number(draft.testerId)
        : DEFAULT_UPLOAD_PARAMETERS.testerId,
    version,
    summary: version,
    description: version,
    testResultReference: "",
    mode:
      draft.mode === "prepare_publish" ||
      draft.mode === "upload_only" ||
      draft.mode === "prepare_test"
        ? "prepare_publish"
        : "publish_workflow",
  };
}

export function projectUploadDraft(value: unknown, defaults: Record<string, unknown>): UploadInput {
  const draft =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<UploadInput>)
      : {};
  const input = uploadDraftDefaults({ ...defaults, ...draft });
  return {
    ...input,
    productId: String(defaults.productId ?? ""),
    channelId: String(defaults.channelId ?? ""),
    belongName: String(defaults.belongName ?? ""),
    testerId: Number(draft.testerId ?? defaults.testerId ?? 0),
  };
}

export const UPLOAD_MODES: { id: UploadMode; label: string; description: string }[] = [
  {
    id: "publish_workflow",
    label: "完成发布",
    description: "完成上传、提测及发布准备，自动确认正式发布",
  },
  {
    id: "prepare_publish",
    label: "等待最终确认",
    description: "完成上传、提测及发布准备，只留下最后一步确认",
  },
];
export const UPLOAD_STEPS = [
  { label: "登录与下载", stages: ["NEW", "AUTHENTICATING", "DOWNLOADING"], done: "CREATE_VERSION" },
  { label: "创建版本", stages: ["CREATE_VERSION", "PREPARE_VERSION"], done: "PREPARE_VERSION" },
  {
    label: "上传增量包",
    stages: ["RESOLVE_OBJECT", "UPLOADING", "REGISTER_OBJECT"],
    done: "OBJECT_READY",
  },
  {
    label: "绑定与解压",
    stages: ["BIND_PACKAGE", "WAIT_TEST_ASSETS", "TEST_ASSETS_READY"],
    done: "WAIT_TEST_ASSETS",
  },
  {
    label: "完成提测流程",
    stages: ["REQUEST_TEST", "TEST_REQUESTED", "START_TEST", "PASS_TEST"],
    done: "PASS_TEST",
  },
  {
    label: "准备正式资源",
    stages: ["WAIT_RELEASE_COPY", "WAIT_RELEASE_ASSETS", "PREPARE_PUBLISH"],
    done: "PREPARE_PUBLISH",
  },
  {
    label: "确认正式发布",
    stages: ["AWAITING_PUBLISH_CONFIRMATION", "REQUEST_PUBLISH", "WAIT_PUBLISHED", "PUBLISHED"],
    done: "WAIT_PUBLISHED",
  },
];
const STAGES: Record<string, string> = {
  NEW: "等待启动",
  AUTHENTICATING: "正在检查登录",
  DOWNLOADING: "下载并校验增量包",
  CREATE_VERSION: "创建版本",
  PREPARE_VERSION: "准备版本",
  RESOLVE_OBJECT: "检查文件是否已上传",
  UPLOADING: "上传增量包",
  REGISTER_OBJECT: "登记上传文件",
  BIND_PACKAGE: "绑定版本与增量包",
  WAIT_TEST_ASSETS: "等待测试目录解压",
  TEST_ASSETS_READY: "上传完成 · 测试包已就绪",
  REQUEST_TEST: "提交测试",
  TEST_REQUESTED: "已提测 · 等待人工测试",
  START_TEST: "登记测试状态",
  PASS_TEST: "完成平台测试状态登记",
  WAIT_RELEASE_ASSETS: "等待复制正式资源",
  WAIT_RELEASE_COPY: "等待正式资源复制",
  PREPARE_PUBLISH: "准备正式发布",
  REQUEST_PUBLISH: "提交正式发布",
  WAIT_PUBLISHED: "核验最终发布状态",
  PUBLISHED: "正式发布完成",
  AWAITING_PUBLISH_CONFIRMATION: "等待最终确认发布",
};
const ERRORS: Record<string, string> = {
  UPLOAD_SOURCE_NO_ZIP: "所选平台、配置或版本还没有已核验的热更 ZIP，请等待构建完成或核对版本。",
  UPLOAD_SOURCE_UNAVAILABLE: "暂时无法读取构建目录，请稍后恢复任务。",
  BUILD_RESULT_UNAVAILABLE: "暂时无法读取构建产物清单，请稍后恢复任务。",
  BUILD_ARTIFACT_MISMATCH: "ZIP 与构建清单的版本、平台、产品渠道或 SHA-256 不一致，已停止上传。",
  BUILD_ZIP_CHANGED: "增量包大小或修改时间已变化，本次已停止上传，请核对构建结果。",
  BUILD_PLATFORM_UNSUPPORTED: "打外网包按钮构建 Android，请在上传增量页选择 iOS 并上传已有 ZIP。",
  CHECKPOINT_WRITE_FAILED:
    "服务端保存上传断点失败，原任务和增量包已保留。请检查文件占用或磁盘状态后恢复任务。",
  WAITING_REMOTE_STATE: "正在等待平台处理结果，后台会继续核对。",
  REMOTE_PUBLISHED_RECONCILED: "已同步平台上的正式发布结果。",
  UPLOAD_CHANNEL_HELD: "同产品和渠道有未完成任务，正在等待前一任务完成或确认发布。",
  UPLOAD_QUEUE_BUSY: "服务端正在核对任务，稍后重试即可；提交标识已保留。",
  UPLOAD_SERVICE_UNAVAILABLE: "暂时无法连接上传服务，已有任务仍保存在服务端。",
  UPLOAD_ACCOUNT_IN_USE: "账号有未完成任务，暂不能切换或移除；可使用原账号重新登录。",
  UPLOAD_SERVER_STANDBY: "服务正在切换，请稍后刷新。",
  UPLOAD_REQUEST_CONFLICT: "提交标识与已有任务不一致，请刷新后核对。",
  AUTH_REQUIRED: "登录已失效或尚未配置，请登录后恢复任务。",
  FORBIDDEN: "当前账号没有操作权限，请核对平台账号。",
  INVALID_INPUT: "请检查产品、渠道、版本号和测试人 ID。",
  TEST_RESULT_REQUIRED: "增量包已提测。请填写本次测试人 ID 和实际测试结论引用，然后继续发布。",
  TEST_RESULT_LOCKED: "本任务已开始登记测试状态，测试人和测试结论不能再替换。",
  REMOTE_RESULT_UNKNOWN: "上次操作结果尚不明确。恢复时工具会先核对远端状态，无法确认时会继续停留。",
  VERSION_CONFLICT: "版本或任务配置与原断点冲突，请到平台核对当前版本。",
  OBJECT_CONFLICT: "上传对象与本任务不一致，请核对平台文件。",
  FILE_CHANGED: "原任务的增量文件已改变或丢失。请保留现场并恢复原文件。",
  JOB_LOCKED: "这个任务已在另一个上传进程中运行。",
  UPLOADER_BUSY: "当前有操作或上传任务正在运行，请等待完成。",
  UPLOADER_MISSING: "服务端上传程序未就绪，任务记录已保留，请联系维护人员。",
  UPLOADER_INTEGRITY_FAILED: "服务端上传程序校验失败，任务记录已保留，请联系维护人员。",
  UPLOADER_START_FAILED: "上传进程未能启动。任务记录已保留，可重试启动。",
  LOGIN_SCHEMA_CHANGED: "平台登录响应与当前接口不一致，请到平台检查是否需要网页登录验证。",
  NETWORK_FAILED: "暂时无法连接平台，请检查网络后重试。",
  PLATFORM_FAILED: "平台暂时无法处理请求，请稍后重试。",
  LOCAL_STATE_INVALID: "服务端账号或任务记录无法读取，请保留记录并检查服务端记录。",
  PROCESSING_TIMEOUT: "等待平台处理超时，恢复任务可继续查询进度。",
  NETWORK_TIMEOUT: "平台请求超时，任务断点已保留。",
  JOB_COMPLETED: "该任务已完成，获取最新增量包请新建任务。",
  JOB_NOT_FOUND: "未找到当前用户的服务端任务记录。",
  PUBLISH_NOT_READY: "任务尚未到达最终确认发布步骤，请先完成前序处理。",
  REMOTE_PROCESSING_FAILED: "平台解压或复制失败，请查看平台处理结果后恢复。",
};
export const uploadStageLabel = (stage: string): string => STAGES[stage] ?? "正在处理";
export const uploadErrorLabel = (code: string): string =>
  ERRORS[code] ?? `操作暂未完成，记录已保留（${code || "UNKNOWN"}）。`;
export function uploadJobLabel(job: UploadJob): string {
  if (job.status === "paused") return "已暂停 · 等待明确恢复";
  if (job.status === "queued") return "服务端排队中";
  if (job.status === "cancelled") return "已取消排队";
  if (job.active) return uploadStageLabel(job.stage);
  if (job.published) return "正式发布完成";
  if (job.status === "succeeded") return uploadStageLabel(job.stage);
  if (job.status === "awaiting_test") return "等待测试结论";
  if (job.status === "awaiting_publish") return "等待最终确认发布";
  return job.status === "interrupted" ? "已中断 · 可恢复" : "待处理 · 可恢复";
}
export function uploadProgress(job: UploadJob) {
  const event = [...job.events]
    .reverse()
    .find(
      (event) => event.kind === (job.stage === "DOWNLOADING" ? "downloadProgress" : "progress"),
    );
  if (!event || !["DOWNLOADING", "UPLOADING"].includes(job.stage)) return null;
  return {
    ...event,
    percent:
      event.totalBytes > 0
        ? Math.min(100, Math.round((event.completedBytes / event.totalBytes) * 100))
        : null,
  };
}
