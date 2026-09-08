import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DEFAULT_UPLOAD_PARAMETERS } from "./uploader-types.js";
import type {
  UploadEvent,
  UploadInput,
  UploadJob,
  UploadLogin,
  UploaderSnapshot,
  UploadSourceIdentity,
} from "./uploader-types.js";

export const UPLOADER_SHA256 = "370bd5e8a81ff6d99886c8cbb40edb274b5e5359cd1c67535eaf3d6e1c3e828f";
export const UPLOAD_SOURCE =
  "http://10.100.5.129:8000/pkg_zip/ozdqp/_pkg_cfg_2001_1002.zip?download=true";
const API_BASE = "https://fq2ivi.ipwana.com";
const LOGIN_BASE = "https://54cetx.jiaxiangxm.com";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type RecordValue = Record<string, unknown>;
export function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
}
const str = (value: unknown, limit = 2000): string =>
  typeof value === "string" ? value.slice(0, limit) : "";
const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
function textInput(value: unknown, max: number, required = false): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
  )
    throw new Error("INVALID_INPUT");
  if (required && !value.trim()) throw new Error("INVALID_INPUT");
  return value.trim();
}
function tester(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 2147483647)
    throw new Error("INVALID_INPUT");
  return value;
}
export function parseUploadInput(value: unknown): UploadInput {
  const v = record(value);
  if (
    !["upload_only", "prepare_test", "publish_workflow", "prepare_publish"].includes(
      String(v["mode"]),
    )
  )
    throw new Error("INVALID_INPUT");
  const productId = textInput(v["productId"], 20, true);
  const channelId = textInput(v["channelId"], 20, true);
  if (!/^[1-9]\d*$/.test(productId) || !/^[1-9]\d*$/.test(channelId))
    throw new Error("INVALID_INPUT");
  const version = textInput(v["version"], 80);
  if (version && !/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(version)) throw new Error("INVALID_INPUT");
  return {
    productId,
    channelId,
    version,
    belongName: textInput(v["belongName"], 300, true),
    summary: textInput(v["summary"], 300, true),
    description: textInput(v["description"], 10000, true),
    mode: v["mode"] as UploadInput["mode"],
    testerId: tester(v["testerId"]),
    testResultReference: textInput(v["testResultReference"], 2000),
  };
}
export async function readJson(file: string): Promise<RecordValue | null> {
  try {
    const stat = await fs.stat(file);
    if (stat.size > 2 * 1024 * 1024) throw new Error("LOCAL_STATE_INVALID");
    return record(JSON.parse(await fs.readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("LOCAL_STATE_INVALID");
  }
}
export function parseNewUploadInput(value: unknown): UploadInput {
  const raw = record(value);
  if (raw["mode"] !== "publish_workflow" && raw["mode"] !== "prepare_publish")
    throw new Error("INVALID_INPUT");
  const version = textInput(raw["version"] ?? "", 80);
  const input = parseUploadInput({
    ...DEFAULT_UPLOAD_PARAMETERS,
    ...raw,
    version,
    summary: version || "自动版本号",
    description: version || "自动版本号",
    testResultReference: "",
  });
  if (input.testerId <= 0) throw new Error("INVALID_INPUT");
  return input;
}
export async function writeJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
}
function running(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}
export function parseUploadEvents(lines: string): UploadEvent[] {
  const result: UploadEvent[] = [];
  for (const line of lines.split(/\r?\n/u)) {
    try {
      const event = record(JSON.parse(line));
      if (event["type"] !== "event" && event["type"] !== "error") continue;
      const data = record(event["data"]);
      result.push({
        at: str(event["at"], 80),
        stage: str(event["stage"], 80),
        kind: str(event["event"], 80),
        code: str(data["code"] ?? event["code"], 100),
        completedBytes: num(data["completedBytes"] ?? data["received"]),
        totalBytes: num(data["totalBytes"] ?? data["total"]),
        completedParts: num(data["completedParts"]),
        totalParts: num(data["totalParts"]),
        ...(Number.isSafeInteger(data["concurrency"]) &&
        Number(data["concurrency"]) >= 1 &&
        Number(data["concurrency"]) <= 8
          ? { concurrency: Number(data["concurrency"]) }
          : {}),
      });
    } catch {
      /* A writer may still be appending the last line. */
    }
  }
  return result.slice(-120);
}
async function tail(file: string): Promise<string> {
  try {
    const handle = await fs.open(file, "r");
    try {
      const size = (await handle.stat()).size;
      const buffer = Buffer.alloc(Math.min(size, 128 * 1024));
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        Math.max(0, size - buffer.length),
      );
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export interface HostOptions {
  environment?: Record<string, string>;
  root: string;
  authFile: string;
  executable: string;
  runner: string;
  nodeExecutable: string;
  fetch?: typeof fetch;
}
export class UploaderHost {
  private mutating = false;
  constructor(private readonly options: HostOptions) {}
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.mutating) throw new Error("UPLOADER_BUSY");
    this.mutating = true;
    try {
      return await action();
    } finally {
      this.mutating = false;
    }
  }
  folder(id: unknown): string {
    if (typeof id !== "string" || !UUID.test(id)) throw new Error("INVALID_INPUT");
    return path.join(this.options.root, id);
  }
  async verifiedExecutable(): Promise<void> {
    try {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(this.options.executable))
        hash.update(chunk as Buffer);
      if (hash.digest("hex") !== UPLOADER_SHA256) throw new Error("UPLOADER_INTEGRITY_FAILED");
    } catch (error) {
      if (error instanceof Error && error.message === "UPLOADER_INTEGRITY_FAILED") throw error;
      throw new Error("UPLOADER_MISSING");
    }
  }
  private async job(id: string): Promise<UploadJob> {
    const directory = this.folder(id);
    const meta = await readJson(path.join(directory, "desktop.json"));
    if (!meta) throw new Error("JOB_NOT_FOUND");
    const config = await readJson(path.join(directory, "job.json"));
    let input = parseUploadInput({ ...config, version: config?.["version"] ?? "" });
    const state = (await readJson(path.join(directory, "state.json"))) ?? {};
    if (config?.["useVersionText"] === true && state["version"])
      input = {
        ...input,
        summary: str(state["version"], 80),
        description: str(state["version"], 80),
      };
    const runId = str(meta["runId"]);
    if (!UUID.test(runId)) throw new Error("LOCAL_STATE_INVALID");
    const receipt = await readJson(path.join(directory, `run-${runId}.json`));
    const started = Date.parse(str(meta["runStartedAt"]));
    const heartbeat = Date.parse(str(receipt?.["updatedAt"]));
    const active =
      receipt?.["finished"] !== true &&
      ((running(receipt?.["pid"] ?? meta["pid"]) &&
        Date.now() - (Number.isFinite(heartbeat) ? heartbeat : started) < 20000) ||
        (!receipt && Date.now() - started < 15000));
    const events = parseUploadEvents(await tail(path.join(directory, `run-${runId}.jsonl`)));
    const errorCode =
      [...events].reverse().find((e) => e.code)?.code ?? str(receipt?.["errorCode"]);
    const stage = str(state["stage"], 80) || "NEW";
    const done = Array.isArray(state["done"])
      ? state["done"].filter((v): v is string => typeof v === "string").slice(0, 80)
      : [];
    const file = record(state["file"]);
    const published =
      state["runStatus"] === "SUCCEEDED" &&
      stage === "PUBLISHED" &&
      state["finalRemoteStatus"] === 100 &&
      Boolean(state["publishTime"]);
    const succeeded =
      state["runStatus"] === "SUCCEEDED" &&
      (input.mode === "publish_workflow" || input.mode === "prepare_publish"
        ? published
        : stage === (input.mode === "upload_only" ? "TEST_ASSETS_READY" : "TEST_REQUESTED"));
    return {
      id,
      createdAt: str(meta["createdAt"]),
      input,
      recordedWorkflow: config?.["recordedTestWorkflow"] === true,
      active,
      stage,
      status: active
        ? "running"
        : succeeded
          ? "succeeded"
          : input.mode === "prepare_publish" &&
              stage === "AWAITING_PUBLISH_CONFIRMATION" &&
              state["runStatus"] === "WAITING" &&
              state["finalRemoteStatus"] === 60 &&
              done.includes("PREPARE_PUBLISH") &&
              !state["pendingAction"]
            ? "awaiting_publish"
            : errorCode === "TEST_RESULT_REQUIRED"
              ? "awaiting_test"
              : errorCode ||
                  state["runStatus"] === "FAILED" ||
                  state["runStatus"] === "AUTH_REQUIRED"
                ? "failed"
                : "interrupted",
      errorCode,
      version: str(state["version"], 80) || input.version,
      versionId: num(state["versionId"]),
      sha256: str(file["sha256"], 64),
      size: num(file["size"]),
      done,
      testResultLocked:
        done.includes("START_TEST") ||
        ["START_TEST", "PASS_TEST"].includes(str(state["pendingAction"])),
      pendingAction: str(state["pendingAction"], 80),
      published,
      publishTime: str(state["publishTime"], 80),
      remoteStatus: num(state["finalRemoteStatus"]),
      events,
    };
  }
  async snapshot(): Promise<UploaderSnapshot> {
    await fs.mkdir(this.options.root, { recursive: true });
    let auth: RecordValue | null = null;
    let authError = false;
    try {
      auth = await readJson(this.options.authFile);
    } catch {
      authError = true;
    }
    let available = true;
    try {
      await fs.access(this.options.executable);
    } catch {
      available = false;
    }
    const ids = (await fs.readdir(this.options.root)).filter((id) => UUID.test(id));
    const jobs: UploadJob[] = [];
    let unreadableJobs = 0;
    for (const id of ids) {
      try {
        jobs.push(await this.job(id));
      } catch {
        unreadableJobs++;
      }
    }
    jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      available,
      toolVersion: "0.4.1",
      sourceUrl: UPLOAD_SOURCE,
      configured: !!auth,
      authError,
      account: str(auth?.["account"], 200),
      kind: auth?.["kind"] === "subaccount" ? "subaccount" : "email",
      jobs,
      unreadableJobs,
    };
  }
  private async idle(): Promise<void> {
    const snapshot = await this.snapshot();
    if (snapshot.jobs.some((job) => job.active)) throw new Error("UPLOADER_BUSY");
    if (snapshot.unreadableJobs) throw new Error("LOCAL_STATE_INVALID");
  }
  private async request(
    origin: string,
    route: string,
    body: unknown,
    authorization = "",
  ): Promise<RecordValue> {
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${origin}${route}`, {
        method: body === null ? "GET" : "POST",
        redirect: "error",
        signal: AbortSignal.timeout(90000),
        headers: {
          Accept: "application/json",
          "ruixue-language": "zh",
          ...(body === null ? {} : { "Content-Type": "application/json" }),
          ...(authorization ? { Authorization: authorization } : {}),
        },
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error("NETWORK_FAILED");
    }
    if (response.status === 401) throw new Error("AUTH_REQUIRED");
    if (response.status === 403) throw new Error("FORBIDDEN");
    if (!response.ok) throw new Error("PLATFORM_FAILED");
    let result: RecordValue;
    try {
      result = record(await response.json());
    } catch {
      throw new Error("LOGIN_SCHEMA_CHANGED");
    }
    if (result["code"] !== 0 && result["code"] !== "0") throw new Error("AUTH_REQUIRED");
    return record(result["data"]);
  }
  async login(value: unknown): Promise<boolean> {
    return this.exclusive(async () => {
      await this.idle();
      const input = record(value);
      const account = textInput(input["account"], 200, true);
      if (
        typeof input["password"] !== "string" ||
        !input["password"] ||
        input["password"].length > 1000
      )
        throw new Error("INVALID_INPUT");
      if (input["kind"] !== "email" && input["kind"] !== "subaccount")
        throw new Error("INVALID_INPUT");
      const kind: UploadLogin["kind"] = input["kind"];
      const data = await this.request(
        LOGIN_BASE,
        `/api/v1/gwapi/login/${kind === "email" ? "unified" : "extension"}`,
        {
          account,
          password: createHash("md5").update(input["password"], "utf8").digest("hex").toUpperCase(),
          language: "zh",
          ...(kind === "email" ? { login_type: "password", generate_token: true } : {}),
        },
      );
      let token = str(data["access_token"], 20000);
      if (!token && kind === "subaccount") {
        try {
          const url = new URL(str(data["new_skip_url"] || data["skip_url"], 30000));
          if (![LOGIN_BASE, API_BASE].includes(url.origin)) throw new Error();
          const values = [
            ...url.searchParams.getAll("access_token"),
            ...new URLSearchParams(url.hash.slice(1).replace(/^.*?\?/, "")).getAll("access_token"),
          ];
          if (values.length === 1) token = values[0] ?? "";
        } catch {
          throw new Error("LOGIN_SCHEMA_CHANGED");
        }
      }
      if (!token || /REDACTED|[\r\n]/iu.test(token)) throw new Error("LOGIN_SCHEMA_CHANGED");
      await this.request(API_BASE, "/api/v1/thirdpartyadminapi/oss_provider", null, token);
      await writeJson(this.options.authFile, {
        accessToken: token,
        refreshToken: str(data["refresh_token"], 20000),
        apiBase: API_BASE,
        loginBase: LOGIN_BASE,
        account,
        password: input["password"],
        kind,
      });
      return true;
    });
  }
  async logout(): Promise<boolean> {
    return this.exclusive(async () => {
      await this.idle();
      await fs.rm(this.options.authFile, { force: true });
      return true;
    });
  }
  async checkAuth(): Promise<boolean> {
    return this.exclusive(async () => {
      await this.idle();
      if (!(await readJson(this.options.authFile))) throw new Error("AUTH_REQUIRED");
      await this.verifiedExecutable();
      return new Promise<boolean>((resolve, reject) => {
        const child = spawn(this.options.executable, ["auth-check"], {
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
          env: this.workerEnvironment(),
        });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output = (output + chunk.toString("utf8")).slice(-64000);
        });
        child.once("error", () => reject(new Error("UPLOADER_START_FAILED")));
        child.once("close", (code) =>
          code === 0 && output.includes('"ok":true')
            ? resolve(true)
            : reject(
                new Error(parseUploadEvents(output).find((e) => e.code)?.code || "AUTH_REQUIRED"),
              ),
        );
      });
    });
  }
  async accountIdentity(): Promise<string> {
    const auth = await readJson(this.options.authFile);
    if (!auth || !auth["account"]) throw new Error("AUTH_REQUIRED");
    return createHash("sha256")
      .update(JSON.stringify([API_BASE, auth["account"], auth["kind"]]))
      .digest("hex");
  }
  async hasBuildJob(id: string): Promise<boolean> {
    return (await readJson(path.join(this.folder(id), "desktop.json"))) !== null;
  }
  private workerEnvironment(): NodeJS.ProcessEnv {
    const env = { ...process.env, ...this.options.environment };
    delete env["OZDQP_AUTHORIZATION"];
    return env;
  }
  private async launch(
    id: string,
    command: "run" | "resume" | "confirm-publish",
    createdAt: string,
  ): Promise<string> {
    const directory = this.folder(id);
    const runId = randomUUID();
    const meta = { createdAt, runId, runStartedAt: new Date().toISOString() };
    await writeJson(path.join(directory, "desktop.json"), meta);
    const child = spawn(
      this.options.nodeExecutable,
      [this.options.runner, this.options.executable, directory, runId, command],
      {
        detached: true,
        windowsHide: true,
        stdio: "ignore",
        env: { ...this.workerEnvironment(), ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(new Error("UPLOADER_START_FAILED")));
    }).catch(async (error) => {
      await writeJson(path.join(directory, `run-${runId}.json`), {
        finished: true,
        errorCode: "UPLOADER_START_FAILED",
      });
      throw error;
    });
    child.unref();
    await writeJson(path.join(directory, "desktop.json"), { ...meta, pid: child.pid });
    return id;
  }
  async start(value: unknown): Promise<string> {
    return this.startJob(value, randomUUID());
  }
  async startWithId(value: unknown, id: string): Promise<string> {
    return this.startJob(value, id);
  }
  // Only the main-process build coordinator supplies an identity and a pinned source.
  async startForBuild(
    value: unknown,
    id: string,
    source: UploadSourceIdentity,
    accountIdentity: string,
  ): Promise<string> {
    if (
      !Number.isSafeInteger(source.size) ||
      source.size <= 0 ||
      !Number.isFinite(Date.parse(source.lastModified))
    )
      throw new Error("INVALID_INPUT");
    return this.startJob(value, id, source, accountIdentity);
  }
  private async startJob(
    value: unknown,
    id: string,
    source?: UploadSourceIdentity,
    accountIdentity?: string,
  ): Promise<string> {
    return this.exclusive(async () => {
      const input = parseNewUploadInput(value);
      const directory = this.folder(id);
      const existing = await readJson(path.join(directory, "job.json"));
      if (existing) {
        if (
          (source && existing["buildChainId"] !== id) ||
          JSON.stringify(existing["expectedSource"]) !== JSON.stringify(source) ||
          JSON.stringify(
            parseNewUploadInput({ ...existing, version: existing["version"] ?? "" }),
          ) !== JSON.stringify(input)
        )
          throw new Error("LOCAL_STATE_INVALID");
        // The launch intent is written before spawn. Never create a second job on a lost acknowledgement.
        if (await readJson(path.join(directory, "desktop.json"))) return id;
      }
      await this.idle();
      if (source && (!accountIdentity || (await this.accountIdentity()) !== accountIdentity))
        throw new Error("UPLOAD_ACCOUNT_CHANGED");
      if (!(await readJson(this.options.authFile))) throw new Error("AUTH_REQUIRED");
      await this.verifiedExecutable();
      await writeJson(path.join(directory, "job.json"), {
        ...input,
        useVersionText: true,
        recordedTestWorkflow: true,
        version: input.version || null,
        existingVersionId: null,
        apiBase: API_BASE,
        workDirectory: directory,
        pollSeconds: 3,
        waitTimeoutSeconds: 1800,
        partSizeBytes: 5242880,
        uploadConcurrency: 8,
        ...(source ? { buildChainId: id, expectedSource: source } : {}),
      });
      return this.launch(id, "run", new Date().toISOString());
    });
  }
  async resume(value: unknown): Promise<string> {
    return this.exclusive(async () => {
      const v = record(value);
      const directory = this.folder(v["id"]);
      await this.idle();
      await this.verifiedExecutable();
      const job = await this.job(String(v["id"]));
      if (job.status === "succeeded") throw new Error("JOB_COMPLETED");
      const testerId = tester(v["testerId"]);
      const testResultReference = textInput(v["testResultReference"], 2000);
      if (
        job.testResultLocked &&
        (testerId !== job.input.testerId || testResultReference !== job.input.testResultReference)
      )
        throw new Error("TEST_RESULT_LOCKED");
      const config = await readJson(path.join(directory, "job.json"));
      if (!config) throw new Error("JOB_NOT_FOUND");
      await writeJson(path.join(directory, "job.json"), {
        ...config,
        testerId,
        testResultReference,
      });
      const state = await readJson(path.join(directory, "state.json"));
      return this.launch(job.id, state ? "resume" : "run", job.createdAt);
    });
  }
  async confirmPublish(id: unknown): Promise<string> {
    return this.exclusive(async () => {
      this.folder(id);
      await this.idle();
      const job = await this.job(String(id));
      if (job.input.mode !== "prepare_publish" || job.status !== "awaiting_publish")
        throw new Error("PUBLISH_NOT_READY");
      if (!(await readJson(this.options.authFile))) throw new Error("AUTH_REQUIRED");
      await this.verifiedExecutable();
      return this.launch(job.id, "confirm-publish", job.createdAt);
    });
  }
}
