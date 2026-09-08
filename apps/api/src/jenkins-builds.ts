import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  applyBuildHistory,
  describeBuild,
  parseBuildLog,
  type JenkinsBuildRecord,
  type PackagingProgress,
  type ParsedBuildLog,
} from "./jenkins-progress.js";

const TIMEOUT_MS = 8_000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

export const BUILD_PRESETS = ["internal-nosdk", "internal-sdk", "external"] as const;
export type BuildPreset = string;
export interface JenkinsProjectConfiguration {
  readonly projectId: string;
  readonly version: number;
  readonly origin: string;
  readonly downloadOrigin: string;
  readonly jobPath: string;
  readonly authorization: string;
  readonly zipPath: string;
  readonly presets: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly apkPath?: string;
  readonly ipaPath?: string;
}
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
  return {
    networkScope: preset === "external" ? "外网_保留原参数" : "内网_自动判断",
    internalUseSdk: preset === "internal-sdk" ? "接入SDK" : "不接入SDK",
    // Switching to external in ParameterUX also switches this hidden selection.
    buildMode: preset === "external" ? "App_资源和包体" : "Auto_自动判断",
  };
}

export function packageFiles(
  files: DirectoryFile[],
  kind: "apk" | "ipa",
  downloadOrigin = "",
  directoryPath = `/${kind}/`,
): PackageFile[] {
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
      url: `${downloadOrigin}${directoryPath}${encodeURIComponent(file.name)}`,
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
  private logCache = new Map<number, { until: number; value: Promise<ParsedBuildLog> }>();
  private observedStages = new Map<string, number>();
  private submissions = new Map<
    string,
    {
      preset: BuildPreset;
      createdAt: number;
      result: Promise<{ queueId: number; preset: BuildPreset }>;
    }
  >();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly configuration?: JenkinsProjectConfiguration,
  ) {}
  private get config(): JenkinsProjectConfiguration {
    if (!this.configuration) throw new PackagingError("COMPONENT_NOT_CONFIGURED", 409);
    return this.configuration;
  }
  private configuredPreset(actions: JenkinsParameters[] = []): BuildPreset | null {
    const parameters = Object.fromEntries(
      actions
        .flatMap((action) => action.parameters ?? [])
        .map((parameter) => [parameter.name, parameter.value]),
    );
    return (
      Object.entries(this.config.presets).find(([, values]) =>
        Object.entries(values).every(([key, value]) => String(parameters[key] ?? "") === value),
      )?.[0] ?? null
    );
  }

  private async request(
    path: string,
    init: RequestInit = {},
    authenticate = true,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (authenticate) {
      headers.set("authorization", this.config.authorization);
      if (this.cookies.size > 0)
        headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${authenticate ? this.config.origin : this.config.downloadOrigin}${path}`,
        {
          ...init,
          headers,
          redirect: "manual",
          signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS),
        },
      );
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

  private async job(signal?: AbortSignal, progress = false): Promise<JenkinsJob> {
    const tree = progress
      ? "buildable,builds[number,timestamp,duration,estimatedDuration,queueId,builtOn,building,result,actions[causes[userName],parameters[name,value]]]{0,24}"
      : "buildable,property[parameterDefinitions[name,choices]],builds[number,timestamp,building,result,actions[parameters[name,value]]]{0,10}";
    let response = await this.request(
      `${this.config.jobPath}api/json?tree=${encodeURIComponent(tree)}`,
      signal ? { signal } : {},
    );
    if ([401, 403, 302].includes(response.status)) {
      await response.body?.cancel();
      this.cookies.clear();
      this.crumb = null;
      response = await this.request(
        `${this.config.jobPath}api/json?tree=${encodeURIComponent(tree)}`,
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

  private async submit(preset: BuildPreset): Promise<{ queueId: number; preset: BuildPreset }> {
    const signal = AbortSignal.timeout(15_000);
    const job = await this.job(signal);
    if (!job.buildable) throw new PackagingError("JENKINS_JOB_DISABLED", 409);
    const parameters = this.config.presets[preset];
    if (!parameters) throw new PackagingError("BUILD_PRESET_NOT_CONFIGURED", 400);
    const definitions = job.property?.flatMap((p) => p.parameterDefinitions ?? []) ?? [];
    for (const [name, value] of Object.entries(parameters)) {
      const definition = definitions.find((p) => p.name === name);
      if (!definition || (definition.choices && !definition.choices.includes(value))) {
        throw new PackagingError("JENKINS_PARAMETERS_CHANGED", 409);
      }
    }
    if (!this.crumb) await this.loadCrumb(signal);
    for (let attempt = 0; attempt < 2; attempt++) {
      const crumb = this.crumb!;
      let response: Response;
      try {
        response = await this.request(`${this.config.jobPath}buildWithParameters`, {
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
      const queueUrl = location ? new URL(location, this.config.origin) : null;
      const queue =
        queueUrl?.origin === this.config.origin
          ? /^\/queue\/item\/(\d+)\/?$/u.exec(queueUrl.pathname)
          : null;
      if (response.status !== 201 || !queue)
        throw new PackagingError("JENKINS_SUBMISSION_UNKNOWN", 502);
      this.cachedStatus = null;
      return { preset, queueId: Number(queue[1]) };
    }
    throw new PackagingError("JENKINS_AUTH_FAILED");
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
      await this.request(
        `${kind === "apk" ? (this.config.apkPath ?? "/apk/") : (this.config.ipaPath ?? "/ipa/")}?json=true`,
        {},
        false,
      ),
    );
    if (!Array.isArray(listing.files)) throw new PackagingError("PACKAGING_INVALID_RESPONSE");
    return packageFiles(
      listing.files,
      kind,
      this.config.downloadOrigin,
      kind === "apk" ? (this.config.apkPath ?? "/apk/") : (this.config.ipaPath ?? "/ipa/"),
    );
  }

  private async readStatus() {
    const [jenkins, apk, ipa, zip] = await Promise.allSettled([
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
          builds: job.builds.map((build) => ({
            number: build.number,
            startedAt: new Date(build.timestamp).toISOString(),
            status: build.building ? "BUILDING" : (build.result ?? "UNKNOWN"),
            preset: this.configuredPreset(build.actions),
          })),
          queue: queue.items
            .filter(
              (q) =>
                q.task?.url === `${this.config.origin}${this.config.jobPath}` ||
                decodeURI(q.task?.url ?? "") ===
                  decodeURI(`${this.config.origin}${this.config.jobPath}`),
            )
            .map((q) => ({ id: q.id, reason: q.why, preset: this.configuredPreset(q.actions) })),
        };
      })(),
      this.directory("apk"),
      this.directory("ipa"),
      this.request(this.config.zipPath, { method: "HEAD" }, false).then((r) => {
        if (!r.ok) throw new PackagingError("PACKAGING_UNAVAILABLE");
        return {
          url: `${this.config.downloadOrigin}${this.config.zipPath}`,
          name: this.config.zipPath.split("/").at(-1) ?? "artifact.zip",
          size: Number(r.headers.get("content-length")),
          modifiedAt: r.headers.get("last-modified"),
        };
      }),
    ]);
    const errorCode = (error: unknown) =>
      error instanceof PackagingError ? error.code : "PACKAGING_UNAVAILABLE";
    return {
      checkedAt: new Date().toISOString(),
      jenkins: jenkins.status === "fulfilled" ? jenkins.value : null,
      jenkinsError: jenkins.status === "rejected" ? errorCode(jenkins.reason) : null,
      apks: apk.status === "fulfilled" ? apk.value : [],
      apkError: apk.status === "rejected" ? errorCode(apk.reason) : null,
      ipas: ipa.status === "fulfilled" ? ipa.value : [],
      ipaError: ipa.status === "rejected" ? errorCode(ipa.reason) : null,
      zip: zip.status === "fulfilled" ? zip.value : null,
      zipError: zip.status === "rejected" ? errorCode(zip.reason) : null,
    };
  }

  status(): Promise<PackagingStatus> {
    if (this.cachedStatus && this.cachedStatus.until > Date.now()) return this.cachedStatus.value;
    const value = this.readStatus();
    this.cachedStatus = { until: Date.now() + 5_000, value };
    return value;
  }

  private buildLog(build: JenkinsBuildRecord, signal: AbortSignal): Promise<ParsedBuildLog> {
    const previous = this.logCache.get(build.number);
    if (previous && previous.until > Date.now()) return previous.value;
    const value = (async () => {
      const response = await this.request(
        `${this.config.jobPath}${build.number}/timestamps/?elapsed=HH:mm:ss.SSS&appendLog`,
        { signal },
      );
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
    this.logCache.set(build.number, {
      until: Date.now() + (build.building ? 4_000 : 86_400_000),
      value,
    });
    void value.catch(() => {
      this.logCache.delete(build.number);
    });
    while (this.logCache.size > 80) this.logCache.delete(this.logCache.keys().next().value!);
    return value;
  }

  private async readProgress(
    queueIds: number[],
    buildNumbers: number[],
  ): Promise<PackagingProgress> {
    const signal = AbortSignal.timeout(18_000);
    const job = await this.job(signal, true);
    const builds = job.builds.filter(
      (build) =>
        buildNumbers.includes(build.number) ||
        (build.queueId !== undefined && queueIds.includes(build.queueId)),
    );
    const queues: PackagingProgress["queues"] = [];
    const buildTree =
      "number,timestamp,duration,estimatedDuration,queueId,builtOn,building,result,actions[causes[userName],parameters[name,value]]";
    const loadBuild = async (number: number) => {
      if (builds.some((b) => b.number === number)) return;
      const build = await this.readJson<JenkinsBuildRecord>(
        await this.request(
          `${this.config.jobPath}${number}/api/json?tree=${encodeURIComponent(buildTree)}`,
          {
            signal,
          },
        ),
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
            decodeURI(item.task?.url ?? "") !==
              decodeURI(`${this.config.origin}${this.config.jobPath}`)
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
    const descriptions: ReturnType<typeof describeBuild>[] = [];
    let index = 0;
    // Cap concurrent console reads so inspecting history does not flood Jenkins.
    await Promise.all(
      Array.from({ length: Math.min(3, builds.length) }, async () => {
        while (index < builds.length) {
          const build = builds[index++]!;
          try {
            descriptions.push({
              ...describeBuild(
                build,
                await this.buildLog(build, signal),
                Date.now(),
                this.observedStages,
              ),
              preset: this.configuredPreset(build.actions),
            });
          } catch {
            descriptions.push({
              ...describeBuild(build, parseBuildLog(""), Date.now(), this.observedStages, true),
              preset: this.configuredPreset(build.actions),
            });
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

  progress(queueIds: number[] = [], buildNumbers: number[] = []): Promise<PackagingProgress> {
    const key = `${[...queueIds].sort((a, b) => a - b)}:${[...buildNumbers].sort((a, b) => a - b)}`;
    const previous = this.progressCache.get(key);
    if (previous && previous.until > Date.now()) return previous.value;
    const value = this.readProgress(queueIds, buildNumbers);
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
}

export interface PackagingStatus {
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
        !(BUILD_PRESETS as readonly string[]).includes(preset) ||
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
