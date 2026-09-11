import { QaHubMcpError, type McpToolDefinition, type QaHubApiTransport } from "./mcp-api.js";
import { QUICK_BUILD_PRESETS, quickUploadInput } from "@relay-qa-hub/upload-contract";

const uuidPattern = "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$";
const uuid = { type: "string", pattern: uuidPattern };
const requestId = {
  ...uuid,
  description: "本次操作的 UUID。超时或重试必须复用同一个值，不能重新生成。",
};
const modes = ["publish_workflow", "prepare_publish"] as const;
const presets = QUICK_BUILD_PRESETS.map((p) => p.id);
// These public defaults are checked against upload-contract by the MCP tests.
// The EXE sends commands only; all execution and platform credentials stay on the API host.
const defaults = {
  productId: "2002",
  channelId: "1002",
  belongName: "[2002]Baloot Go|[1002]谷歌-国际正式",
  testerId: 11562,
};
const uploadProperties = {
  requestId,
  platform: { type: "string", enum: ["android", "ios"], default: "android" },
  configuration: { type: "string", enum: ["Debug", "Release"], default: "Release" },
  mode: {
    type: "string",
    enum: modes,
    default: "publish_workflow",
    description: "publish_workflow 完成正式发布；prepare_publish 只停在最终确认前。",
  },
  version: {
    type: "string",
    maxLength: 80,
    pattern: "^([0-9A-Za-z][0-9A-Za-z._-]*)?$",
    default: "",
    description:
      "留空选择该平台配置最新已核验构建；指定时选择该构建版本。瑞雪版本与构建版本完全一致。",
  },
  testerId: { type: "integer", minimum: 1, maximum: 2147483647, default: defaults.testerId },
};
const tool = (
  name: string,
  title: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
  write = false,
): McpToolDefinition => ({
  name,
  title,
  description,
  inputSchema: { type: "object", additionalProperties: false, properties, required },
  annotations: {
    readOnlyHint: !write,
    destructiveHint: write,
    idempotentHint: name !== "qa_start_build",
    openWorldHint: true,
  },
});
const numbers = {
  type: "array",
  items: { type: "integer", minimum: 1, maximum: 9999999999 },
  minItems: 1,
  maxItems: 10,
  uniqueItems: true,
};
export const PACKAGING_MCP_TOOLS: readonly McpToolDefinition[] = [
  tool(
    "qa_get_packaging_status",
    "查询打包进度与下载",
    "不传参数读取构建队列、最近构建与包下载；传 queueIds/buildNumbers 读取对应排队原因、阶段和进度。",
    { queueIds: numbers, buildNumbers: numbers },
  ),
  tool(
    "qa_start_build",
    "提交打包",
    "提交统一快捷打包入口的 8 种预设：Android/iOS、Debug/Release、app 安装包与完整热更或 res 增量热更。只构建；自动上传用 qa_build_and_upload。返回排队回执；未知结果先查询，不得自动重提。单独构建的去重不跨 API 重启。",
    { requestId, preset: { type: "string", enum: presets, default: "android-release-app" } },
    ["requestId"],
    true,
  ),
  tool(
    "qa_get_increment_upload_status",
    "查询增量上传与一键任务",
    "读取所有人的上传和一键打包上传记录、排队原因及错误；可指定 jobId 或 chainId 跟踪一个任务。链状态 upload_started 只代表开始上传，正式发布必须核对 job.published 和 remoteStatus。includeLogs 读取所选任务的脱敏日志。",
    { jobId: uuid, chainId: uuid, includeLogs: { type: "boolean", default: false } },
  ),
  tool(
    "qa_start_increment_upload",
    "上传已有增量包",
    "上传指定平台和配置已有的已核验构建 ZIP。Debug 产品 2001、Release 产品 2002；Android 渠道 1002、iOS 渠道 2004。版本取构建结果，校验 SHA-256，默认测试人 11562、8 分片并发。复用服务端账户，重试复用 requestId。",
    uploadProperties,
    ["requestId"],
    true,
  ),
  tool(
    "qa_build_and_upload",
    "一键构建并上传增量",
    "提交 8 种快捷打包预设之一，后端等待该构建成功后读取本次产物清单，校验上下游构建、平台配置、产品渠道、版本、ZIP SHA-256，再自动上传。瑞雪版本与构建完全一致；按 mode 发布或等最终确认。关闭 EXE 继续执行，复用 requestId，用 chainId 跟踪。",
    {
      requestId,
      mode: uploadProperties.mode,
      testerId: uploadProperties.testerId,
      preset: { type: "string", enum: presets, default: "android-release-app" },
    },
    ["requestId"],
    true,
  ),
  tool(
    "qa_resume_increment_upload",
    "恢复原增量上传",
    "恢复当前登录用户的失败或中断任务，保留原 ZIP、版本、测试人和已上传分片。不能恢复已完成任务；等待最终确认时用 qa_confirm_increment_publish。重试复用 requestId。",
    { requestId, jobId: uuid },
    ["requestId", "jobId"],
    true,
  ),
  tool(
    "qa_confirm_increment_publish",
    "确认增量正式发布",
    "执行原任务最后一步正式发布，仅适用于当前登录用户的 awaiting_publish 任务。用户要求正式发布后调用；重试复用 requestId。",
    { requestId, jobId: uuid },
    ["requestId", "jobId"],
    true,
  ),
  tool(
    "qa_cancel_increment_upload",
    "取消排队中的增量上传",
    "仅取消当前登录用户尚未开始的上传排队，不会中止已运行的上传或删除任务记录。",
    { jobId: uuid },
    ["jobId"],
    true,
  ),
  tool(
    "qa_cancel_build_upload",
    "取消打包后的自动上传",
    "取消当前登录用户的一键任务后续自动上传；已提交的 Jenkins 构建继续执行。上传已开始后拒绝此操作。保留任务记录。",
    { chainId: uuid },
    ["chainId"],
    true,
  ),
];

function invalid(message: string): never {
  throw new QaHubMcpError("INVALID_ARGUMENTS", message, 400);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("参数必须为对象");
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !new RegExp(uuidPattern).test(value))
    invalid("ID 必须为小写 UUID");
  return value;
}
function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) invalid("不支持的选项");
  return value as T;
}
function uploadInput(input: Record<string, unknown>, build: boolean) {
  const platform = choice(input["platform"], ["android", "ios"], "android");
  const configuration = choice(input["configuration"], ["Debug", "Release"], "Release");
  const mode = choice(input["mode"], modes, "publish_workflow");
  const version = input["version"] === undefined ? "" : input["version"];
  if (
    typeof version !== "string" ||
    version.length > 80 ||
    !/^([0-9A-Za-z][0-9A-Za-z._-]*)?$/.test(version)
  )
    invalid("版本号格式不正确");
  const testerId = input["testerId"] === undefined ? defaults.testerId : input["testerId"];
  if (!Number.isSafeInteger(testerId) || Number(testerId) < 1 || Number(testerId) > 2147483647)
    invalid("测试人 ID 必须为正整数");
  const productId = configuration === "Debug" ? "2001" : "2002";
  const channelId = platform === "ios" ? "2004" : "1002";
  const upload = {
    ...defaults,
    productId,
    channelId,
    belongName: `[${productId}]Baloot Go|[${channelId}]${platform === "ios" ? "iOS" : "谷歌-国际正式"}`,
    testerId: Number(testerId),
    version,
    summary: version,
    description: version,
    testResultReference: "",
    mode,
  };
  return build
    ? quickUploadInput(upload, choice(input["preset"], presets, "android-release-app"))
    : upload;
}
function items(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value))
    throw new QaHubMcpError("QA_HUB_INVALID_RESPONSE", "服务端任务列表格式不正确", 502);
  return value.map(record);
}
const base = "/api/v1/increment-upload";

export async function callPackagingTool(
  name: string,
  value: unknown,
  api: QaHubApiTransport,
): Promise<unknown> {
  const definition = PACKAGING_MCP_TOOLS.find((t) => t.name === name);
  if (!definition) throw new QaHubMcpError("TOOL_NOT_FOUND", "未知的打包上传工具", 404);
  const input = record(value);
  const allowed = definition.inputSchema["properties"] as Record<string, unknown>;
  if (Object.keys(input).some((key) => !Object.hasOwn(allowed, key))) invalid("包含不支持的参数");
  for (const key of definition.inputSchema["required"] as string[])
    if (input[key] === undefined) invalid(`缺少 ${key}`);
  if (name === "qa_get_packaging_status") {
    const query = new URLSearchParams();
    for (const [key, field] of [
      ["queueIds", "queues"],
      ["buildNumbers", "builds"],
    ]) {
      const values = input[key!];
      if (values === undefined) continue;
      if (
        !Array.isArray(values) ||
        values.length < 1 ||
        values.length > 10 ||
        new Set(values).size !== values.length ||
        values.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 9999999999)
      )
        invalid("构建/队列编号必须为 1 至 10 个不重复的正整数");
      query.set(field!, values.join(","));
    }
    return api.json(query.size ? `/api/v1/packaging/progress?${query}` : "/api/v1/packaging");
  }
  if (name === "qa_get_increment_upload_status") {
    const jobId = input["jobId"] === undefined ? undefined : id(input["jobId"]);
    const chainId = input["chainId"] === undefined ? undefined : id(input["chainId"]);
    if (jobId && chainId) invalid("jobId 和 chainId 只指定一个");
    if (input["includeLogs"] !== undefined && typeof input["includeLogs"] !== "boolean")
      invalid("includeLogs 必须为布尔值");
    if (input["includeLogs"] && !jobId && !chainId) invalid("读取日志需指定 jobId 或 chainId");
    const [snapshotValue, chainsValue] = await Promise.all([
      api.json(base),
      api.json(`${base}/build-chains`),
    ]);
    const snapshot = record(snapshotValue),
      jobs = items(snapshot["jobs"]),
      chains = items(chainsValue);
    const chain = chainId ? chains.find((c) => c["id"] === chainId) : undefined;
    if (chainId && !chain) throw new QaHubMcpError("JOB_NOT_FOUND", "未找到一键任务", 404);
    const selectedId = jobId ?? chain?.["uploadJobId"];
    const job = selectedId ? jobs.find((j) => j["id"] === selectedId) : undefined;
    if (jobId && !job) throw new QaHubMcpError("JOB_NOT_FOUND", "未找到上传任务", 404);
    return {
      execution: "server",
      available: snapshot["available"],
      configured: snapshot["configured"],
      authError: snapshot["authError"],
      toolVersion: snapshot["toolVersion"],
      unreadableJobs: snapshot["unreadableJobs"],
      defaults: { ...defaults, mode: "publish_workflow", version: "", concurrency: 8 },
      ...(jobId || chainId ? { job: job ?? null, chain: chain ?? null } : { jobs, chains }),
      ...(input["includeLogs"] && job
        ? { logs: await api.json(`${base}/jobs/${id(job["id"])}/logs`) }
        : {}),
    };
  }
  const post = (url: string, body: unknown, key?: string) =>
    api.json(url, {
      method: "POST",
      body,
      ...(key ? { headers: { "idempotency-key": key } } : {}),
    });
  if (name === "qa_start_build") {
    const key = id(input["requestId"]),
      preset = choice(input["preset"], presets, "android-release-app");
    const receipt = record(await post("/api/v1/packaging/builds", { preset }, key));
    return {
      accepted: true,
      execution: "server",
      requestId: key,
      ...receipt,
      nextTool: "qa_get_packaging_status",
    };
  }
  if (name === "qa_start_increment_upload" || name === "qa_build_and_upload") {
    const key = id(input["requestId"]),
      build = name === "qa_build_and_upload",
      upload = uploadInput(input, build);
    if (build) {
      const chain = record(
        await post(
          `${base}/build-chains`,
          { upload, preset: choice(input["preset"], presets, "android-release-app") },
          key,
        ),
      );
      return {
        accepted: true,
        execution: "server",
        requestId: key,
        chainId: chain["id"],
        chain,
        nextTool: "qa_get_increment_upload_status",
      };
    }
    const jobId = await post(`${base}/jobs`, upload, key);
    return {
      accepted: true,
      execution: "server",
      requestId: key,
      jobId: id(jobId),
      nextTool: "qa_get_increment_upload_status",
    };
  }
  if (name === "qa_resume_increment_upload" || name === "qa_confirm_increment_publish") {
    const key = id(input["requestId"]),
      jobId = id(input["jobId"]);
    const action = name === "qa_resume_increment_upload" ? "resume" : "confirm-publish";
    await post(`${base}/jobs/${jobId}/${action}`, {}, key);
    return {
      accepted: true,
      execution: "server",
      requestId: key,
      jobId,
      nextTool: "qa_get_increment_upload_status",
    };
  }
  const build = name === "qa_cancel_build_upload",
    taskId = id(input[build ? "chainId" : "jobId"]);
  const cancelled = await post(`${base}/${build ? "build-chains" : "jobs"}/${taskId}/cancel`, {});
  return { cancelled, execution: "server", [build ? "chainId" : "jobId"]: taskId };
}
