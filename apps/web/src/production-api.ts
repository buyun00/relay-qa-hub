import { requestJson, QaHubApiError } from "./api";

export interface ExecutionOptions {
  codexModel: string;
  codexReasoningEffort: string;
  codexFastMode: boolean;
  priority: number;
  autoRelease: boolean;
  executionProfile: string;
  extraPrompt: string;
}
export const defaultExecution: ExecutionOptions = {
  codexModel: "gpt-5.6-sol",
  codexReasoningEffort: "xhigh",
  codexFastMode: false,
  priority: 0,
  autoRelease: true,
  executionProfile: "auto",
  extraPrompt: "",
};
export interface ProductionTask {
  id: string;
  number: number;
  title: string;
  status: string;
  createdBy: string;
  branchName: string | null;
  baseBranch: string;
  latestCommitSha: string | null;
  bugId: string | null;
  attemptId: string | null;
  handoffId: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  codexModel: string;
  codexReasoningEffort: string;
  codexFastMode: boolean;
  latestTurn: { id: string; sequence: number; status: string; errorMessage: string | null } | null;
}
export interface ProductionFile {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}
export interface ProductionDetail {
  task: ProductionTask;
  turns: {
    id: string;
    sequence: number;
    userMessage: string;
    authorName: string;
    status: string;
    result: unknown;
    commitSha: string | null;
    errorMessage: string | null;
    createdAt: string;
    attachments: ProductionFile[];
  }[];
  progress: { id: string; message: string; createdAt: string }[];
  builds: { id: string; status: string; commitSha: string | null; lastError: string | null }[];
}
export interface ProductionProject {
  project: { id: string; name: string; repoUrl: string; defaultBranch: string; enabled: boolean };
  models: Record<string, string[]>;
}
export interface ProductionBatch {
  id: string;
  kind: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  items: {
    input: { bugId?: string; title?: string; taskId?: string; action?: string };
    status: string;
    result?: {
      taskId?: string;
      bugId?: string;
      repairAttemptId?: string;
      status?: string;
      message?: string;
    };
    error?: { code: string; message: string };
    delivery?: { status: string; failureSummary: string | null };
  }[];
}
export interface ProductionSubmission {
  projectId: string;
  requestId: string;
  kind: "create" | "bugs" | "action";
  items: Record<string, unknown>[];
  execution?: ExecutionOptions;
}
const base = "/api/v1/production";
export async function productionGet<T>(
  path: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<T> {
  return (await requestJson(`${base}${path}?${new URLSearchParams({ projectId })}`, {
    ...(signal ? { signal } : {}),
  })) as T;
}
export async function productionSubmit(body: ProductionSubmission): Promise<ProductionBatch> {
  return (await requestJson(`${base}/batches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })) as ProductionBatch;
}
export async function productionRetry(id: string, projectId: string): Promise<ProductionBatch> {
  return (await requestJson(`${base}/batches/${id}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId }),
  })) as ProductionBatch;
}
export function fileMediaType(file: File): string {
  if (file.name.toLowerCase().endsWith(".log") || file.name.toLowerCase().endsWith(".txt"))
    return "text/plain";
  if (file.name.toLowerCase().endsWith(".zip")) return "application/zip";
  return file.type;
}
export async function uploadProductionFile(projectId: string, file: File): Promise<string> {
  const mediaType = fileMediaType(file);
  if (
    !new Set([
      "image/png",
      "image/jpeg",
      "image/webp",
      "text/plain",
      "application/json",
      "application/zip",
    ]).has(mediaType) ||
    file.size < 1 ||
    file.size > 25 * 1024 * 1024
  )
    throw new Error("附件支持 PNG、JPG、WebP、TXT、LOG、JSON、ZIP，每个最多 25 MB");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  const uploaded = (await requestJson(`${base}/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      filename: file.name,
      mediaType,
      sha256,
      contentBase64: btoa(binary),
    }),
  })) as { id: string };
  return uploaded.id;
}
export async function downloadProductionFile(
  projectId: string,
  file: ProductionFile,
): Promise<void> {
  const result = await productionGet<{ contentBase64: string }>(
    `/attachments/${file.id}`,
    projectId,
  );
  const bytes = Uint8Array.from(atob(result.contentBase64), (character) => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: file.contentType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
export function productionError(error: unknown): string {
  if (error instanceof QaHubApiError) {
    const messages: Record<string, string> = {
      PRODUCTION_UNCONFIGURED: "尚未配置制作服务，请联系管理员。",
      PROJECT_FORBIDDEN: "当前身份无权执行此操作。",
      TASK_CHANGED: "任务已更新，请刷新后重试。",
      FORBIDDEN: "制作服务未授权此功能，请检查服务配置。",
      REQUEST_TIMEOUT: "暂未收到结果，请核对本次提交；同一请求不会重复创建。",
      IDEMPOTENCY_PAYLOAD_MISMATCH: "上次提交内容与当前请求不同，请查看批次记录。",
    };
    return (
      messages[error.code ?? ""] ?? `暂时无法完成操作（${error.code ?? "连接失败"}），请稍后重试。`
    );
  }
  return error instanceof Error ? error.message : "暂时无法完成操作。";
}
export const productionStatuses: Record<string, string> = {
  queued: "排队中",
  running: "制作中",
  validating: "验证中",
  waiting_user: "待反馈",
  needs_input: "需补充",
  blocked: "已阻塞",
  failed: "失败",
  cancelled: "已停止",
  interrupted: "已中断",
  closed: "已结束",
  completed: "已交付",
  delivered: "已交付",
  preparing: "准备中",
};
