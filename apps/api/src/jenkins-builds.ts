import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  QUICK_JOB_NAME,
  COMPATIBILITY_JOB_NAME,
  QUICK_BUILD_PRESETS,
  quickBuildPreset,
  type QuickBuildPresetId,
} from "@relay-qa-hub/upload-contract";
import { artifactCatalog, validateBuildResult, type BuildResult } from "./build-artifacts.js";
import {
  COMPATIBILITY_TARGETS,
  compatibilitySource,
  validateCompatibilityReport,
  type CompatibilityTarget,
  type CompatibilityCheck,
} from "./jenkins-compatibility.js";
import {
  applyBuildHistory,
  describeBuild,
  parseBuildLog,
  type JenkinsBuildRecord,
  type PackagingProgress,
  type ParsedBuildLog,
} from "./jenkins-progress.js";

// Fixed intranet installation, as requested. Credentials stay in the API process.
const JENKINS_ORIGIN = "http://10.100.5.129:8080";
const DOWNLOAD_ORIGIN = "http://10.100.5.129:8000";
const JOB_PATH = `/job/${encodeURIComponent(QUICK_JOB_NAME)}/`;
const CHECK_JOB_PATH = `/job/${encodeURIComponent(COMPATIBILITY_JOB_NAME)}/`;
const LEGACY_JOB_PATH = `/job/${encodeURIComponent("01-【OZDQP】【Android】")}/`;
const JENKINS_AUTH = `Basic ${Buffer.from("admin:admin").toString("base64")}`;
const TIMEOUT_MS = 8_000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

export const BUILD_PRESETS = QUICK_BUILD_PRESETS.map((p) => p.id);
export type BuildPreset = QuickBuildPresetId | "internal-nosdk" | "internal-sdk" | "external";
export const JENKINS_BUILDS_PATH = "/api/v1/packaging";

interface ParameterDefinition {
  name: string;
  choices?: string[];
}
interface JenkinsParameters {
  parameters?: { name: string; value?: unknown }[];
}
interface JenkinsJob {
  buildable: boolean;
  builds: JenkinsBuildRecord[];
  property?: { parameterDefinitions?: ParameterDefinition[] }[];
}
interface DirectoryFile {
  name: string;
  type: string;
  size: number;
  mtime: number;
}
export interface PackageFile {
  name: string;
  size: number;
  modifiedAt: string;
  url: string;
  kind: "apk" | "ipa";
  preset: BuildPreset | null;
}

export class PackagingError extends Error {
  constructor(
    readonly code: string,
    readonly status = 502,
  ) {
    super(code);
  }
}

/** Only these choices change. Jenkins supplies every other parameter's current default,
 * including the Json Editor plugin's BuildParam startval and the blank version. */
export function buildParameters(preset: BuildPreset): Record<string, string> {
  const selection = quickBuildPreset(preset === "external" ? "android-release-app" : preset);
  if (!selection) throw new PackagingError("JENKINS_PARAMETERS_CHANGED", 409);
  return { 打包用途: selection.label };
}

function presetForParameters(actions: JenkinsParameters[] = []): BuildPreset | null {
  const values = Object.fromEntries(
    actions.flatMap((action) => action.parameters ?? []).map((p) => [p.name, p.value]),
  );
  const quick = QUICK_BUILD_PRESETS.find((p) => p.label === values["打包用途"]);
  if (quick) return quick.id;
  if (values["networkScope"] === "外网_保留原参数") return "external";
  if (values["networkScope"] !== "内网_自动判断") return null;
  return values["internalUseSdk"] === "接入SDK" ? "internal-sdk" : "internal-nosdk";
}
function isCompatibilityBuild(actions: JenkinsParameters[] = []): boolean {
  const purpose = actions
    .flatMap((a) => a.parameters ?? [])
    .find((p) => p.name === "打包用途")?.value;
  return COMPATIBILITY_TARGETS.some(
    (t) => purpose === `${t.platform} ${t.configuration} · 快捷检测`,
  );
}
function sameJenkinsUrl(value: unknown, expected: string): boolean {
  if (typeof value !== "string") return false;
  try {
    const actual = new URL(value),
      wanted = new URL(expected);
    return (
      actual.origin === wanted.origin &&
      !actual.username &&
      !actual.password &&
      !actual.search &&
      !actual.hash &&
      decodeURI(actual.pathname) === decodeURI(wanted.pathname)
    );
  } catch {
    return false;
  }
}

export function packageFiles(files: DirectoryFile[], kind: "apk" | "ipa"): PackageFile[] {
  return files
    .filter(
      (file) =>
        file.type === "file" &&
        /^[^/\\\u0000-\u001f]+$/u.test(file.name) &&
        file.name.toLowerCase().endsWith(`.${kind}`) &&
        Number.isSafeInteger(file.size) &&
        file.size > 0 &&
        Number.isFinite(file.mtime) &&
        !Number.isNaN(new Date(file.mtime).valueOf()),
    )
    .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
    .map((file) => ({
      name: file.name,
      size: file.size,
      modifiedAt: new Date(file.mtime).toISOString(),
      url: `${DOWNLOAD_ORIGIN}/${kind}/${encodeURIComponent(file.name)}`,
      kind,
      preset: /_intra_nosdk\./iu.test(file.name)
        ? "internal-nosdk"
        : /_intra_sdk\./iu.test(file.name)
          ? "internal-sdk"
          : /_extra_(?:no)?sdk\./iu.test(file.name)
            ? "external"
            : null,
    }));
}

export class JenkinsBuildService {
  private cookies = new Map<string, string>();
  private crumb: { crumbRequestField: string; crumb: string } | null = null;
  private crumbLoading: Promise<void> | null = null;
  private cachedStatus: { until: number; value: Promise<PackagingStatus> } | null = null;
  private progressCache = new Map<string, { until: number; value: Promise<PackagingProgress> }>();
  private logCache = new Map<string, { until: number; value: Promise<ParsedBuildLog> }>();
  private observedStages = new Map<string, number>();
  private submissions = new Map<
    string,
    {
      preset: BuildPreset;
      createdAt: number;
      result: Promise<{ queueId: number; preset: BuildPreset }>;
    }
  >();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async request(
    path: string,
    init: RequestInit = {},
    authenticate = true,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (authenticate) {
      headers.set("authorization", JENKINS_AUTH);
      if (this.cookies.size > 0)
        headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${authenticate ? JENKINS_ORIGIN : DOWNLOAD_ORIGIN}${path}`, {
        ...init,
        headers,
        redirect: "manual",
        signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new PackagingError("PACKAGING_UNAVAILABLE", 503);
    }
    if (authenticate) {
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(";");
        const separator = pair?.indexOf("=") ?? -1;
        if (pair && separator > 0)
          this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
    }
    return response;
  }

  private async readJson<T>(response: Response): Promise<T> {
    if (!response.ok) {
      await response.body?.cancel();
      throw new PackagingError(
        response.status === 401 || response.status === 403 || response.status === 302
          ? "JENKINS_AUTH_FAILED"
          : "PACKAGING_UNAVAILABLE",
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new PackagingError("PACKAGING_INVALID_RESPONSE");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_JSON_BYTES) throw new PackagingError("PACKAGING_INVALID_RESPONSE");
        chunks.push(next.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (error instanceof PackagingError) throw error;
      throw new PackagingError("PACKAGING_INVALID_RESPONSE");
    } finally {
      reader.releaseLock();
    }
  }

  private async job(
    signal?: AbortSignal,
    progress = false,
    jobPath = JOB_PATH,
  ): Promise<JenkinsJob> {
    const tree = progress
      ? "buildable,builds[number,timestamp,duration,estimatedDuration,queueId,builtOn,building,result,actions[causes[userName],parameters[name,value]]]{0,24}"
      : "buildable,property[parameterDefinitions[name,choices]],builds[number,timestamp,building,result,actions[parameters[name,value]]]{0,10}";
    let response = await this.request(
      `${jobPath}api/json?tree=${encodeURIComponent(tree)}`,
      signal ? { signal } : {},
    );
    if ([401, 403, 302].includes(response.status)) {
      await response.body?.cancel();
      this.cookies.clear();
      this.crumb = null;
      response = await this.request(
        `${jobPath}api/json?tree=${encodeURIComponent(tree)}`,
        signal ? { signal } : {},
      );
    }
    const job = await this.readJson<JenkinsJob>(response);
    if (typeof job.buildable !== "boolean" || !Array.isArray(job.builds))
      throw new PackagingError("PACKAGING_INVALID_RESPONSE");
    return job;
  }

  private async loadCrumb(signal: AbortSignal): Promise<void> {
    this.crumbLoading ??= (async () => {
      this.cookies.clear();
      const crumb = await this.readJson<{ crumbRequestField: string; crumb: string }>(
        await this.request("/crumbIssuer/api/json", { signal }),
      );
      if (
        !/^[\w-]+$/u.test(crumb.crumbRequestField) ||
        typeof crumb.crumb !== "string" ||
        !crumb.crumb
      ) {
        throw new PackagingError("JENKINS_AUTH_FAILED");
      }
      this.crumb = crumb;
    })().finally(() => {
      this.crumbLoading = null;
    });
    return this.crumbLoading;
  }

  private async submitParameters(
    parameters: Record<string, string>,
    jobPath = JOB_PATH,
  ): Promise<number> {
    const signal = AbortSignal.timeout(15_000);
    const job = await this.job(signal, false, jobPath);
    if (!job.buildable) throw new PackagingError("JENKINS_JOB_DISABLED", 409);
    const definitions = job.property?.flatMap((p) => p.parameterDefinitions ?? []) ?? [];
    if (!definitions.some((p) => p.name === "打包用途"))
      throw new PackagingError("JENKINS_PARAMETERS_CHANGED", 409);
    // Active Choices does not expose choices in api/json. Read its installed script without executing it.
    const configResponse = await this.request(`${jobPath}config.xml`, { signal });
    if (!configResponse.ok) {
      await configResponse.body?.cancel();
      throw new PackagingError("JENKINS_PARAMETERS_CHANGED", 409);
    }
    const config = await configResponse.text();
    if (config.length > MAX_JSON_BYTES || !config.includes(parameters["打包用途"]!))
      throw new PackagingError("JENKINS_PARAMETERS_CHANGED", 409);
    if (!this.crumb) await this.loadCrumb(signal);
    for (let attempt = 0; attempt < 2; attempt++) {
      const crumb = this.crumb!;
      let response: Response;
      try {
        response = await this.request(`${jobPath}buildWithParameters`, {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            [crumb.crumbRequestField]: crumb.crumb,
          },
          body: new URLSearchParams(parameters).toString(),
        });
      } catch {
        // The server might have accepted the build. Never automatically replay it.
        throw new PackagingError("JENKINS_SUBMISSION_UNKNOWN", 504);
      }
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        if (attempt === 0) {
          await this.loadCrumb(signal);
          continue;
        }
        throw new PackagingError("JENKINS_AUTH_FAILED");
      }
      const queueUrl = location ? new URL(location, JENKINS_ORIGIN) : null;
      const queue =
        queueUrl?.origin === JENKINS_ORIGIN
          ? /^\/queue\/item\/(\d+)\/?$/u.exec(queueUrl.pathname)
          : null;
      if (response.status !== 201 || !queue)
        throw new PackagingError("JENKINS_SUBMISSION_UNKNOWN", 502);
      this.cachedStatus = null;
      return Number(queue[1]);
    }
    throw new PackagingError("JENKINS_AUTH_FAILED");
  }

  private async submit(preset: BuildPreset): Promise<{ queueId: number; preset: BuildPreset }> {
    return { preset, queueId: await this.submitParameters(buildParameters(preset)) };
  }

  async startCompatibility(target: CompatibilityTarget): Promise<number> {
    if (
      !COMPATIBILITY_TARGETS.some(
        (t) =>
          t.id === target.id &&
          t.platform === target.platform &&
          t.configuration === target.configuration,
      )
    )
      throw new PackagingError("INVALID_REQUEST", 400);
    const sourceResponse = await this.request(`${JOB_PATH}config.xml`);
    if (!sourceResponse.ok) {
      await sourceResponse.body?.cancel();
      throw new PackagingError("CHECK_SOURCE_UNAVAILABLE", 502);
    }
    const config = await sourceResponse.text();
    if (config.length > MAX_JSON_BYTES) throw new PackagingError("CHECK_SOURCE_CHANGED", 502);
    let source: string;
    try {
      source = compatibilitySource(config);
    } catch {
      throw new PackagingError("CHECK_SOURCE_CHANGED", 502);
    }
    return this.submitParameters(
      {
        打包用途: `${target.platform} ${target.configuration} · 快捷检测`,
        参考版本: "自动：最新成功版本",
        CHECK_SOURCE: source,
      },
      CHECK_JOB_PATH,
    );
  }

  async compatibilityProgress(check: CompatibilityCheck): Promise<CompatibilityCheck> {
    const expected = `${check.target.platform} ${check.target.configuration} · 快捷检测`;
    let number = check.buildNumber;
    if (!number) {
      const response = await this.request(`/queue/item/${check.queueId}/api/json`);
      if (response.status === 404) {
        await response.body?.cancel();
        const recent = await this.job(undefined, true, CHECK_JOB_PATH);
        number = recent.builds.find((b) => b.queueId === check.queueId)?.number ?? null;
        if (!number) throw new PackagingError("CHECK_QUEUE_UNKNOWN");
      } else {
        const q = await this.readJson<{
          id: number;
          cancelled?: boolean;
          task?: { url?: string };
          executable?: { number?: number; url?: string };
        }>(response);
        if (q.id !== check.queueId || !sameJenkinsUrl(q.task?.url, JENKINS_ORIGIN + CHECK_JOB_PATH))
          throw new PackagingError("CHECK_IDENTITY_MISMATCH");
        if (q.cancelled) throw new PackagingError("CHECK_CANCELLED");
        if (!q.executable) return { ...check, state: "queued", errorCode: null };
        number = q.executable.number ?? null;
        if (
          !number ||
          !Number.isSafeInteger(number) ||
          !sameJenkinsUrl(q.executable.url, JENKINS_ORIGIN + CHECK_JOB_PATH + number + "/")
        )
          throw new PackagingError("CHECK_IDENTITY_MISMATCH");
      }
    }
    const b = await this.readJson<{
      number: number;
      queueId: number;
      building: boolean;
      result: string | null;
      timestamp: number;
      duration: number;
      actions?: JenkinsParameters[];
    }>(
      await this.request(
        `${CHECK_JOB_PATH}${number}/api/json?tree=number,queueId,building,result,timestamp,duration,actions[parameters[name,value]]`,
      ),
    );
    const params = Object.fromEntries(
      (b.actions ?? []).flatMap((a) => a.parameters ?? []).map((p) => [p.name, p.value]),
    );
    if (
      b.number !== number ||
      b.queueId !== check.queueId ||
      params["打包用途"] !== expected ||
      !["自动：最新成功版本", "latest"].includes(String(params["参考版本"]))
    )
      throw new PackagingError("CHECK_IDENTITY_MISMATCH");
    if (b.building) return { ...check, buildNumber: number, state: "running", errorCode: null };
    if (!["SUCCESS", "UNSTABLE"].includes(b.result ?? "")) throw new PackagingError("CHECK_FAILED");
    const value = await this.readJson<unknown>(
      await this.request(`${CHECK_JOB_PATH}${number}/artifact/compatibility.json`),
    );
    let report;
    try {
      report = validateCompatibilityReport(value, check.target);
    } catch {
      throw new PackagingError("CHECK_INVALID_REPORT");
    }
    const finishedAt = b.timestamp + b.duration;
    if (!Number.isFinite(finishedAt) || finishedAt <= 0 || finishedAt > Date.now() + 60_000)
      throw new PackagingError("CHECK_INVALID_REPORT");
    return {
      ...check,
      buildNumber: number,
      state: "complete",
      checkedAt: new Date(finishedAt).toISOString(),
      reportUrl: `${JENKINS_ORIGIN}${CHECK_JOB_PATH}${number}/artifact/compatibility.html`,
      report,
      errorCode: null,
    };
  }

  trigger(
    preset: BuildPreset,
    requestId: string,
  ): Promise<{ queueId: number; preset: BuildPreset }> {
    const previous = this.submissions.get(requestId);
    if (previous) {
      if (previous.preset !== preset)
        return Promise.reject(new PackagingError("IDEMPOTENCY_CONFLICT", 409));
      return previous.result;
    }
    for (const [key, entry] of this.submissions) {
      if (entry.createdAt < Date.now() - 86_400_000) this.submissions.delete(key);
    }
    if (this.submissions.size >= 5_000)
      return Promise.reject(new PackagingError("PACKAGING_BUSY", 429));
    const result = this.submit(preset);
    this.submissions.set(requestId, { preset, result, createdAt: Date.now() });
    return result;
  }

  private async directory(kind: "apk" | "ipa"): Promise<PackageFile[]> {
    const listing = await this.readJson<{ files: DirectoryFile[] }>(
      await this.request(`/${kind}/?json=true`, {}, false),
    );
    if (!Array.isArray(listing.files)) throw new PackagingError("PACKAGING_INVALID_RESPONSE");
    return packageFiles(listing.files, kind);
  }

  private async readStatus() {
    const [jenkins, catalogResult] = await Promise.allSettled([
      (async () => {
        const [job, queue] = await Promise.all([
          this.job(),
          this.request(
            `/queue/api/json?tree=${encodeURIComponent("items[id,why,task[url],actions[parameters[name,value]]]")}`,
          ).then((r) =>
            this.readJson<{
              items: {
                id: number;
                why: string;
                task: { url: string };
                actions?: JenkinsParameters[];
              }[];
            }>(r),
          ),
        ]);
        return {
          buildable: job.buildable,
          builds: job.builds
            .filter((build) => !isCompatibilityBuild(build.actions))
            .map((build) => ({
              number: build.number,
              startedAt: new Date(build.timestamp).toISOString(),
              status: build.building ? "BUILDING" : (build.result ?? "UNKNOWN"),
              preset: presetForParameters(build.actions),
            })),
          queue: queue.items
            .filter((q) => !isCompatibilityBuild(q.actions))
            .filter(
              (q) =>
                q.task?.url === `${JENKINS_ORIGIN}${JOB_PATH}` ||
                decodeURI(q.task?.url ?? "") === decodeURI(`${JENKINS_ORIGIN}${JOB_PATH}`),
            )
            .map((q) => ({ id: q.id, reason: q.why, preset: presetForParameters(q.actions) })),
        };
      })(),
      artifactCatalog(this.fetchImpl),
    ]);
    const catalog = catalogResult.status === "fulfilled" ? catalogResult.value : null;
    const errorCode = (error: unknown) =>
      error instanceof PackagingError ? error.code : "PACKAGING_UNAVAILABLE";
    return {
      checkedAt: new Date().toISOString(),
      jenkins: jenkins.status === "fulfilled" ? jenkins.value : null,
      jenkinsError: jenkins.status === "rejected" ? errorCode(jenkins.reason) : null,
      apks: catalog
        ? catalog.flatMap((r) =>
            r.packages
              .filter((f) => f.kind === "apk")
              .map((f) => ({
                ...f,
                kind: "apk" as const,
                modifiedAt: r.modifiedAt!,
                preset: QUICK_BUILD_PRESETS.find(
                  (p) =>
                    p.platform === r.platform &&
                    p.configuration === r.configuration &&
                    p.mode === "App",
                )!.id,
              })),
          )
        : [],
      apkError: catalog ? null : "BUILD_RESULT_UNAVAILABLE",
      ipas: catalog
        ? catalog.flatMap((r) =>
            r.packages
              .filter((f) => f.kind === "ipa")
              .map((f) => ({
                ...f,
                kind: "ipa" as const,
                modifiedAt: r.modifiedAt!,
                preset: QUICK_BUILD_PRESETS.find(
                  (p) =>
                    p.platform === r.platform &&
                    p.configuration === r.configuration &&
                    p.mode === "App",
                )!.id,
              })),
          )
        : [],
      ipaError: catalog ? null : "BUILD_RESULT_UNAVAILABLE",
      zip: null,
      zipError: null,
      artifacts: catalog ?? [],
      artifactError: catalog ? null : "BUILD_RESULT_UNAVAILABLE",
    };
  }

  status(): Promise<PackagingStatus> {
    if (this.cachedStatus && this.cachedStatus.until > Date.now()) return this.cachedStatus.value;
    const value = this.readStatus();
    this.cachedStatus = { until: Date.now() + 5_000, value };
    return value;
  }

  private buildLog(
    build: JenkinsBuildRecord,
    signal: AbortSignal,
    jobPath = JOB_PATH,
  ): Promise<ParsedBuildLog> {
    const cacheNumber = `${jobPath}${build.number}`;
    const previous = this.logCache.get(cacheNumber);
    if (previous && previous.until > Date.now()) return previous.value;
    const value = (async () => {
      let response = await this.request(
        `${jobPath}${build.number}/timestamps/?elapsed=HH:mm:ss.SSS&appendLog`,
        { signal },
      );
      if (response.status === 404) {
        await response.body?.cancel();
        response = await this.request(`${jobPath}${build.number}/consoleText`, { signal });
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new PackagingError("PACKAGING_LOG_UNAVAILABLE");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new PackagingError("PACKAGING_LOG_UNAVAILABLE");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > 2 * 1024 * 1024) throw new PackagingError("PACKAGING_LOG_TOO_LARGE");
          chunks.push(part.value);
        }
        return parseBuildLog(Buffer.concat(chunks).toString("utf8"));
      } catch {
        await reader.cancel().catch(() => undefined);
        throw new PackagingError("PACKAGING_LOG_UNAVAILABLE");
      } finally {
        reader.releaseLock();
      }
    })();
    this.logCache.set(cacheNumber, {
      until: Date.now() + (build.building ? 4_000 : 86_400_000),
      value,
    });
    void value.catch(() => {
      this.logCache.delete(cacheNumber);
    });
    while (this.logCache.size > 80) this.logCache.delete(this.logCache.keys().next().value!);
    return value;
  }

  private async readProgress(
    queueIds: number[],
    buildNumbers: number[],
    legacy = false,
  ): Promise<PackagingProgress> {
    const jobPath = legacy ? LEGACY_JOB_PATH : JOB_PATH;
    const signal = AbortSignal.timeout(18_000);
    const job = await this.job(signal, true, jobPath);
    const builds = [...job.builds];
    const queues: PackagingProgress["queues"] = [];
    const buildTree =
      "number,timestamp,duration,estimatedDuration,queueId,builtOn,building,result,actions[causes[userName],parameters[name,value]]";
    const loadBuild = async (number: number) => {
      if (builds.some((b) => b.number === number)) return;
      const build = await this.readJson<JenkinsBuildRecord>(
        await this.request(`${jobPath}${number}/api/json?tree=${encodeURIComponent(buildTree)}`, {
          signal,
        }),
      );
      if (build.number !== number || !Number.isFinite(build.timestamp))
        throw new PackagingError("PACKAGING_INVALID_RESPONSE");
      if (!builds.some((b) => b.number === number)) builds.push(build);
    };
    // Explicit build numbers keep a tracked task resolvable after it leaves recent history.
    await Promise.all(buildNumbers.map(loadBuild));
    await Promise.all(
      queueIds.map(async (id) => {
        if (builds.some((b) => b.queueId === id)) return;
        try {
          const response = await this.request(
            `/queue/item/${id}/api/json?tree=id,cancelled,why,task[url],executable[number]`,
            { signal },
          );
          if (response.status === 404) {
            await response.body?.cancel();
            throw new Error("Queue expired");
          }
          const item = await this.readJson<{
            id: number;
            cancelled?: boolean;
            why?: string;
            task?: { url: string };
            executable?: { number: number };
          }>(response);
          if (
            item.id !== id ||
            decodeURI(item.task?.url ?? "") !== decodeURI(`${JENKINS_ORIGIN}${jobPath}`)
          )
            throw new Error("Unrelated queue item");
          if (item.cancelled)
            queues.push({ id, status: "CANCELLED", reason: "Jenkins 已取消排队" });
          else if (Number.isSafeInteger(item.executable?.number) && item.executable!.number > 0)
            await loadBuild(item.executable!.number);
          else
            queues.push({
              id,
              status: "QUEUED",
              reason: item.why?.slice(0, 500) || "等待 Jenkins 执行器",
            });
        } catch {
          queues.push({
            id,
            status: "UNKNOWN",
            reason: "暂时无法确认排队状态，正在重试；不会重复提交",
          });
        }
      }),
    );
    // Compatibility checks have their own progress; they are not package builds
    // and must not enter duration baselines or build-completion notifications.
    for (let i = builds.length - 1; i >= 0; i--)
      if (isCompatibilityBuild(builds[i]!.actions)) builds.splice(i, 1);
    const descriptions: ReturnType<typeof describeBuild>[] = [];
    let index = 0;
    // Cap concurrent console reads so inspecting history does not flood Jenkins.
    await Promise.all(
      Array.from({ length: Math.min(3, builds.length) }, async () => {
        while (index < builds.length) {
          const build = builds[index++]!;
          try {
            const parentLog = await this.buildLog(build, signal, jobPath);
            let parsed = parentLog;
            if (!legacy && parentLog.downstream) {
              const link = parentLog.downstream;
              const childPath = `/job/${encodeURIComponent(link.job)}/`;
              try {
                const child = await this.readJson<JenkinsBuildRecord>(
                  await this.request(
                    `${childPath}${link.number}/api/json?tree=${encodeURIComponent(buildTree.replace("causes[userName]", "causes[userName,upstreamProject,upstreamBuild]"))}`,
                    { signal },
                  ),
                );
                if (
                  child.number !== link.number ||
                  !child.actions?.some((a) =>
                    a.causes?.some(
                      (c) =>
                        c.upstreamProject === QUICK_JOB_NAME && c.upstreamBuild === build.number,
                    ),
                  )
                )
                  throw new Error("BUILD_IDENTITY_MISMATCH");
                parsed = structuredClone(await this.buildLog(child, signal, childPath));
                const offset = Math.max(0, child.timestamp - build.timestamp);
                for (const stage of Object.keys(
                  parsed.markers,
                ) as (keyof ParsedBuildLog["markers"])[])
                  if (parsed.markers[stage] !== null && parsed.markers[stage] !== undefined)
                    parsed.markers[stage]! += offset;
                if (parsed.lockWait) {
                  if (parsed.lockWait.start !== null) parsed.lockWait.start += offset;
                  if (parsed.lockWait.end !== null) parsed.lockWait.end += offset;
                }
                if (parentLog.markers.finalize !== undefined)
                  parsed.markers.finalize = parentLog.markers.finalize;
              } catch {
                /* Keep visible parent progress if its downstream log cannot currently be read. */
              }
            }
            const description = describeBuild(build, parsed, Date.now(), this.observedStages);
            if (!legacy && parsed === parentLog && parentLog.downstream) {
              const stage = description.stages.find((s) => s.id === "unity");
              if (stage) {
                stage.label = "执行打包";
                stage.work = "等待底层构建完成，正在同步详细阶段";
              }
            }
            if (quickBuildPreset(description.preset)?.platform === "iOS") {
              const compile = description.stages.find((s) => s.id === "apk");
              if (compile) {
                compile.label = "编译 IPA";
                compile.work = "Xcode 编译、签名并导出 IPA";
              }
            }
            descriptions.push(description);
          } catch {
            descriptions.push(
              describeBuild(build, parseBuildLog(""), Date.now(), this.observedStages, true),
            );
          }
        }
      }),
    );
    for (const [key, value] of this.observedStages)
      if (value < Date.now() - 7 * 86_400_000) this.observedStages.delete(key);
    return {
      checkedAt: new Date().toISOString(),
      builds: applyBuildHistory(descriptions).sort((a, b) => b.number - a.number),
      queues: queues.sort((a, b) => a.id - b.id),
    };
  }

  progress(
    queueIds: number[] = [],
    buildNumbers: number[] = [],
    legacy = false,
  ): Promise<PackagingProgress> {
    const key = `${legacy}:${[...queueIds].sort((a, b) => a - b)}:${[...buildNumbers].sort((a, b) => a - b)}`;
    const previous = this.progressCache.get(key);
    if (previous && previous.until > Date.now()) return previous.value;
    const value = this.readProgress(queueIds, buildNumbers, legacy);
    this.progressCache.set(key, { until: Date.now() + 5_000, value });
    void value.catch(() => {
      this.progressCache.delete(key);
    });
    for (const [key, entry] of this.progressCache)
      if (entry.until < Date.now()) this.progressCache.delete(key);
    while (this.progressCache.size > 100)
      this.progressCache.delete(this.progressCache.keys().next().value!);
    return value;
  }

  async buildResult(number: number, presetId: QuickBuildPresetId): Promise<BuildResult> {
    const preset = quickBuildPreset(presetId);
    if (!preset || !Number.isSafeInteger(number) || number < 1)
      throw new PackagingError("INVALID_REQUEST", 400);
    const parent = await this.readJson<JenkinsBuildRecord>(
      await this.request(`${JOB_PATH}${number}/api/json?depth=2`),
    );
    if (
      parent.number !== number ||
      parent.building ||
      parent.result !== "SUCCESS" ||
      presetForParameters(parent.actions) !== presetId
    )
      throw new PackagingError("BUILD_IDENTITY_MISMATCH", 409);
    const value = await this.readJson<unknown>(
      await this.request(`${JOB_PATH}${number}/artifact/build-result.json`),
    );
    const result = validateBuildResult(value, preset, true);
    if (
      preset.mode === "App" &&
      (result.hotUpdateMode !== "full" ||
        result.packages
          .map((p) => p.kind)
          .sort()
          .join(",") !==
          (preset.platform === "iOS"
            ? "ipa"
            : preset.configuration === "Release"
              ? "aab,apk"
              : "apk"))
    )
      throw new PackagingError("BUILD_ARTIFACT_MISMATCH", 409);
    const child = await this.readJson<{
      number: number;
      building: boolean;
      result: string;
      actions?: { causes?: { upstreamProject?: string; upstreamBuild?: number }[] }[];
    }>(
      await this.request(
        `/job/${encodeURIComponent(preset.childJob)}/${result.childBuildNumber}/api/json?tree=number,building,result,actions[causes[upstreamProject,upstreamBuild]]`,
      ),
    );
    if (
      child.number !== result.childBuildNumber ||
      child.building ||
      child.result !== "SUCCESS" ||
      !child.actions?.some((a) =>
        a.causes?.some((c) => c.upstreamProject === QUICK_JOB_NAME && c.upstreamBuild === number),
      )
    )
      throw new PackagingError("BUILD_IDENTITY_MISMATCH", 409);
    return result;
  }
}

export interface PackagingStatus {
  artifacts?: BuildResult[];
  artifactError?: string | null;
  checkedAt: string;
  jenkins: {
    buildable: boolean;
    builds: { number: number; startedAt: string; status: string; preset: BuildPreset | null }[];
    queue: { id: number; reason: string; preset: BuildPreset | null }[];
  } | null;
  jenkinsError: string | null;
  apks: PackageFile[];
  apkError: string | null;
  ipas: PackageFile[];
  ipaError: string | null;
  zip: { url: string; name: string; size: number; modifiedAt: string | null } | null;
  zipError: string | null;
}

export function registerPackagingRoutes(
  app: FastifyInstance,
  service: JenkinsBuildService,
  actor: (request: FastifyRequest) => string | null,
): void {
  const respond = async (
    request: FastifyRequest,
    reply: FastifyReply,
    operation: (actorId: string) => Promise<unknown>,
  ) => {
    const actorId = actor(request);
    if (!actorId) return reply.code(401).send({ code: "UNAUTHENTICATED" });
    try {
      return reply.header("cache-control", "no-store").send(await operation(actorId));
    } catch (error) {
      if (error instanceof PackagingError)
        return reply.code(error.status).send({ code: error.code });
      return reply.code(503).send({ code: "PACKAGING_UNAVAILABLE" });
    }
  };
  app.get(JENKINS_BUILDS_PATH, (request, reply) => respond(request, reply, () => service.status()));
  app.get(`${JENKINS_BUILDS_PATH}/progress`, (request, reply) =>
    respond(request, reply, () => {
      const query = request.query as Record<string, unknown>;
      const ids = (value: unknown): number[] => {
        if (value === undefined) return [];
        if (typeof value !== "string" || !/^\d{1,10}(,\d{1,10}){0,9}$/u.test(value))
          throw new PackagingError("INVALID_REQUEST", 400);
        const numbers = [...new Set(value.split(",").map(Number))];
        if (numbers.some((n) => !Number.isSafeInteger(n) || n <= 0))
          throw new PackagingError("INVALID_REQUEST", 400);
        return numbers;
      };
      return service.progress(ids(query["queues"]), ids(query["builds"]));
    }),
  );
  app.post(`${JENKINS_BUILDS_PATH}/builds`, (request, reply) =>
    respond(request, reply, async (actorId) => {
      const body = request.body as { preset?: unknown } | null;
      const preset = body?.preset;
      const key = request.headers["idempotency-key"];
      if (
        !body ||
        Object.keys(body).length !== 1 ||
        typeof preset !== "string" ||
        (!BUILD_PRESETS.includes(preset as QuickBuildPresetId) && preset !== "external") ||
        typeof key !== "string" ||
        !/^[a-zA-Z0-9-]{16,80}$/u.test(key)
      ) {
        throw new PackagingError("INVALID_REQUEST", 400);
      }
      const receipt = await service.trigger(preset as BuildPreset, `${actorId}:${key}`);
      request.log.info(
        { actorId, preset, queueId: receipt.queueId },
        "Jenkins build queued from QA Hub",
      );
      reply.code(202);
      return receipt;
    }),
  );
}
