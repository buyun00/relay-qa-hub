import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// Fixed intranet installation, as requested. Credentials stay in the API process.
const JENKINS_ORIGIN = "http://10.100.5.129:8080";
const DOWNLOAD_ORIGIN = "http://10.100.5.129:8000";
const JOB_PATH = `/job/${encodeURIComponent("01-【OZDQP】【Android】")}/`;
const JENKINS_AUTH = `Basic ${Buffer.from("admin:admin").toString("base64")}`;
const ZIP_PATH = "/pkg_zip/ozdqp/_pkg_cfg_2001_1002.zip";
const TIMEOUT_MS = 8_000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;

export const BUILD_PRESETS = ["internal-nosdk", "internal-sdk", "external"] as const;
export type BuildPreset = (typeof BUILD_PRESETS)[number];
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
  builds: {
    number: number;
    timestamp: number;
    building: boolean;
    result: string | null;
    actions?: JenkinsParameters[];
  }[];
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

function presetForParameters(actions: JenkinsParameters[] = []): BuildPreset | null {
  const values = Object.fromEntries(
    actions.flatMap((action) => action.parameters ?? []).map((p) => [p.name, p.value]),
  );
  if (values["networkScope"] === "外网_保留原参数") return "external";
  if (values["networkScope"] !== "内网_自动判断") return null;
  return values["internalUseSdk"] === "接入SDK" ? "internal-sdk" : "internal-nosdk";
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

  private async job(signal?: AbortSignal): Promise<JenkinsJob> {
    const tree =
      "buildable,property[parameterDefinitions[name,choices]],builds[number,timestamp,building,result,actions[parameters[name,value]]]{0,10}";
    let response = await this.request(
      `${JOB_PATH}api/json?tree=${encodeURIComponent(tree)}`,
      signal ? { signal } : {},
    );
    if ([401, 403, 302].includes(response.status)) {
      await response.body?.cancel();
      this.cookies.clear();
      this.crumb = null;
      response = await this.request(
        `${JOB_PATH}api/json?tree=${encodeURIComponent(tree)}`,
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
    const parameters = buildParameters(preset);
    const definitions = job.property?.flatMap((p) => p.parameterDefinitions ?? []) ?? [];
    for (const [name, value] of Object.entries(parameters)) {
      if (!definitions.find((p) => p.name === name)?.choices?.includes(value)) {
        throw new PackagingError("JENKINS_PARAMETERS_CHANGED", 409);
      }
    }
    if (!this.crumb) await this.loadCrumb(signal);
    for (let attempt = 0; attempt < 2; attempt++) {
      const crumb = this.crumb!;
      let response: Response;
      try {
        response = await this.request(`${JOB_PATH}buildWithParameters`, {
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
      await this.request(`/${kind}/?json=true`, {}, false),
    );
    if (!Array.isArray(listing.files)) throw new PackagingError("PACKAGING_INVALID_RESPONSE");
    return packageFiles(listing.files, kind);
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
            preset: presetForParameters(build.actions),
          })),
          queue: queue.items
            .filter(
              (q) =>
                q.task?.url === `${JENKINS_ORIGIN}${JOB_PATH}` ||
                decodeURI(q.task?.url ?? "") === decodeURI(`${JENKINS_ORIGIN}${JOB_PATH}`),
            )
            .map((q) => ({ id: q.id, reason: q.why, preset: presetForParameters(q.actions) })),
        };
      })(),
      this.directory("apk"),
      this.directory("ipa"),
      this.request(ZIP_PATH, { method: "HEAD" }, false).then((r) => {
        if (!r.ok) throw new PackagingError("PACKAGING_UNAVAILABLE");
        return {
          url: `${DOWNLOAD_ORIGIN}${ZIP_PATH}`,
          name: "_pkg_cfg_2001_1002.zip",
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
  app.post(`${JENKINS_BUILDS_PATH}/builds`, (request, reply) =>
    respond(request, reply, async (actorId) => {
      const body = request.body as { preset?: unknown } | null;
      const preset = body?.preset;
      const key = request.headers["idempotency-key"];
      if (
        !body ||
        Object.keys(body).length !== 1 ||
        typeof preset !== "string" ||
        !BUILD_PRESETS.includes(preset as BuildPreset) ||
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
