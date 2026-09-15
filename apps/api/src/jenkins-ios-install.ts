import { readFile } from "node:fs/promises";
import {
  IOS_INSTALL_JOB,
  type IosInstallRequest,
  type IosInstallJob,
  type IosInstallReport,
} from "@relay-qa-hub/upload-contract";
import { PackagingError } from "./jenkins-builds.js";

export const IOS_JOB_PATH = `/job/${encodeURIComponent(IOS_INSTALL_JOB)}/`;
type RecordWithParameters = {
  number?: number;
  id?: number;
  building?: boolean;
  cancelled?: boolean;
  task?: { name?: string };
  actions?: { parameters?: { name: string; value: unknown }[] }[];
  executable?: { number: number; url: string };
};
export interface IosInstallBackend {
  submit(request: IosInstallRequest): Promise<number>;
  poll(request: IosInstallRequest, job: IosInstallJob): Promise<Partial<IosInstallJob>>;
}
export class JenkinsIosInstallBackend implements IosInstallBackend {
  constructor(
    private readonly transport: {
      request: (path: string) => Promise<Response>;
      submit: (parameters: Record<string, string>) => Promise<number>;
    },
  ) {}
  async submit(request: IosInstallRequest) {
    const source = await readFile(
      new URL("../../../scripts/jenkins-ios-install.py", import.meta.url),
      "utf8",
    );
    return this.transport.submit({
      打包用途: request.action === "devices" ? "刷新测试机" : "安装IPA",
      REQUEST_ID: request.id,
      INSTALL_REQUEST: JSON.stringify(request),
      INSTALL_SOURCE: Buffer.from(source).toString("base64"),
    });
  }
  private async json<T>(path: string): Promise<T | null> {
    const response = await this.transport.request(path);
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new PackagingError("IOS_INSTALL_JOB_UNAVAILABLE");
    }
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) throw new PackagingError("IOS_INSTALL_RESULT_MISMATCH");
    return JSON.parse(text) as T;
  }
  private matches(record: RecordWithParameters, request: IosInstallRequest) {
    const parameters = record.actions?.flatMap((a) => a.parameters ?? []) ?? [];
    const id = parameters.find((p) => p.name === "REQUEST_ID")?.value;
    if (id !== request.id) return false;
    const body = parameters.find((p) => p.name === "INSTALL_REQUEST")?.value;
    if (typeof body !== "string" || JSON.stringify(JSON.parse(body)) !== JSON.stringify(request))
      throw new PackagingError("IOS_INSTALL_RESULT_MISMATCH");
    return true;
  }
  async poll(request: IosInstallRequest, job: IosInstallJob): Promise<Partial<IosInstallJob>> {
    let number = job.buildNumber;
    let queueId = job.queueId;
    const fields = "number,building,actions[parameters[name,value]]";
    if (!number && queueId) {
      const queue = await this.json<RecordWithParameters>(
        `/queue/item/${queueId}/api/json?tree=cancelled,task[name],executable[number,url],actions[parameters[name,value]]`,
      );
      if (queue) {
        if (queue.task?.name !== IOS_INSTALL_JOB || !this.matches(queue, request))
          throw new PackagingError("IOS_INSTALL_RESULT_MISMATCH");
        if (queue.cancelled) return { state: "failed", errorCode: "IOS_INSTALL_CANCELLED" };
        if (!queue.executable) return { state: "queued", errorCode: null };
        const expected = `http://10.100.5.129:8080${IOS_JOB_PATH}${queue.executable.number}/`;
        if (decodeURI(queue.executable.url) !== decodeURI(expected))
          throw new PackagingError("IOS_INSTALL_RESULT_MISMATCH");
        number = queue.executable.number;
      }
    }
    if (!number) {
      const [history, queue] = await Promise.all([
        this.json<{ builds: RecordWithParameters[] }>(
          `${IOS_JOB_PATH}api/json?tree=builds[${fields}]{0,60}`,
        ),
        this.json<{ items: RecordWithParameters[] }>(
          "/queue/api/json?tree=items[id,task[name],actions[parameters[name,value]]]",
        ),
      ]);
      const found = history?.builds.filter((b) => this.matches(b, request)) ?? [];
      const queued =
        queue?.items.filter((b) => b.task?.name === IOS_INSTALL_JOB && this.matches(b, request)) ??
        [];
      if (found.length + queued.length > 1) throw new PackagingError("IOS_INSTALL_RESULT_MISMATCH");
      number = found[0]?.number ?? null;
      queueId = queued[0]?.id ?? queueId;
      if (!number)
        return {
          state: queued.length ? "queued" : "submission_unknown",
          queueId,
          errorCode: queued.length ? null : "JENKINS_SUBMISSION_UNKNOWN",
        };
    }
    const build = await this.json<RecordWithParameters>(
      `${IOS_JOB_PATH}${number}/api/json?tree=${fields}`,
    );
    if (!build || build.number !== number || !this.matches(build, request))
      throw new PackagingError("IOS_INSTALL_RESULT_MISMATCH");
    if (build.building) return { state: "running", buildNumber: number, queueId, errorCode: null };
    const report = await this.json<IosInstallReport>(
      `${IOS_JOB_PATH}${number}/artifact/result.json`,
    );
    if (!report)
      return {
        state: "unconfirmed",
        buildNumber: number,
        queueId,
        errorCode: "IOS_INSTALL_UNCONFIRMED",
      };
    validateIosReport(report, request);
    return {
      state: report.status,
      buildNumber: number,
      queueId,
      errorCode: report.errorCode,
      report,
    };
  }
}
export function validateIosReport(report: IosInstallReport, request: IosInstallRequest) {
  const invalid = () => {
    throw new PackagingError("IOS_INSTALL_RESULT_MISMATCH");
  };
  if (
    report?.signingMode === "adhoc" &&
    (request.selection?.configuration !== "Release" ||
      !/^[a-f0-9]{64}$/.test(report.preparedIpaSha256 ?? "") ||
      typeof report.profileName !== "string" ||
      !report.profileName)
  )
    invalid();
  if (
    !report ||
    report.schemaVersion !== 1 ||
    report.requestId !== request.id ||
    report.action !== request.action ||
    !["complete", "failed", "unconfirmed"].includes(report.status) ||
    !Number.isFinite(Date.parse(report.checkedAt)) ||
    !Array.isArray(report.devices) ||
    report.devices.length > 100 ||
    (report.status === "complete"
      ? report.errorCode !== null
      : typeof report.errorCode !== "string")
  )
    invalid();
  for (const device of report.devices) {
    if (
      !device ||
      !/^[a-f0-9-]{36}$/.test(device.id) ||
      typeof device.online !== "boolean" ||
      typeof device.developerMode !== "boolean" ||
      [device.name, device.model, device.osVersion, device.connection].some(
        (s) => typeof s !== "string" || s.length > 300,
      )
    )
      invalid();
  }
  if (
    request.action === "install" &&
    report.status === "complete" &&
    (report.deviceId !== request.selection?.deviceId ||
      report.artifactSha256 !== request.artifact?.sha256 ||
      !report.bundleId ||
      !report.appVersion ||
      !report.appBuild)
  )
    invalid();
}
