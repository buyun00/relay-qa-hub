import { useCallback, useEffect, useRef, useState } from "react";
import {
  defaultIosDevice,
  iosInstallError,
  iosInstallFinished,
  type IosInstallJob,
  type IosInstallSelection,
  type IosInstallSnapshot,
} from "@relay-qa-hub/upload-contract";
import { requestJson, QaHubApiError } from "./api";
import { createUploadRequestId } from "./increment-upload-api";

const empty: IosInstallSnapshot = { devices: [], checkedAt: null, scan: null, installs: [] };
export function useIosInstall(enabled: boolean, userId: string) {
  const [snapshot, setSnapshot] = useState<IosInstallSnapshot>(empty);
  const [deviceId, setDeviceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const chosen = useRef(false);
  const submitting = useRef(false);
  const scanRequested = useRef(false);
  const key = `qa-hub:ios-install-device:${userId}`;
  const choose = (id: string) => {
    chosen.current = true;
    setDeviceId(id);
    try {
      localStorage.setItem(key, id);
    } catch {
      /* Installation works without local persistence. */
    }
  };
  useEffect(() => {
    chosen.current = false;
    try {
      const saved = localStorage.getItem(key);
      if (saved) {
        chosen.current = true;
        setDeviceId(saved);
      } else setDeviceId("");
    } catch {
      setDeviceId("");
    }
  }, [key]);
  const accept = useCallback((value: IosInstallSnapshot) => {
    setSnapshot(value);
    if (!chosen.current) setDeviceId(defaultIosDevice(value.devices));
  }, []);
  const submit = useCallback(
    async (action: "devices" | "install", selection?: IosInstallSelection) => {
      if (submitting.current) return;
      submitting.current = true;
      setPending(true);
      setError(null);
      try {
        await requestJson("/api/v1/packaging/ios-installs", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": createUploadRequestId(),
          },
          body: JSON.stringify({ action, selection }),
        });
        accept((await requestJson("/api/v1/packaging/ios-installs")) as IosInstallSnapshot);
      } catch (e) {
        setError(
          e instanceof QaHubApiError
            ? iosInstallError(e.code)
            : "尚未收到安装服务回执，正在刷新任务记录，请勿重复点击。",
        );
      } finally {
        submitting.current = false;
        setPending(false);
      }
    },
    [accept],
  );
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = (await requestJson("/api/v1/packaging/ios-installs", {
          signal: controller.signal,
        })) as IosInstallSnapshot;
        if (controller.signal.aborted) return;
        accept(value);
        if (
          !scanRequested.current &&
          (!value.scan ||
            (iosInstallFinished(value.scan.state) &&
              Date.now() - Date.parse(value.checkedAt ?? "1970-01-01") > 30000))
        ) {
          scanRequested.current = true;
          void submit("devices");
        }
      } catch {
        if (!controller.signal.aborted) setError("暂时无法读取测试机连接和安装记录，请稍后刷新。");
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [enabled, accept, submit]);
  const device = snapshot.devices.find((d) => d.id === deviceId);
  const active = snapshot.installs.find(
    (j) => j.selection?.deviceId === deviceId && !iosInstallFinished(j.state),
  );
  return {
    snapshot,
    device,
    deviceId,
    choose,
    error,
    pending,
    active,
    scanning: !!snapshot.scan && !iosInstallFinished(snapshot.scan.state),
    refresh: () => {
      scanRequested.current = true;
      void submit("devices");
    },
    install: (selection: Omit<IosInstallSelection, "deviceId">) =>
      void submit("install", { ...selection, deviceId }),
    canInstall: !!device && device.online && device.developerMode && !active && !pending,
  };
}
export type IosInstaller = ReturnType<typeof useIosInstall>;
export function iosJobLabel(job: IosInstallJob): string {
  if (job.errorCode) return iosInstallError(job.errorCode);
  return {
    submitting: "正在提交安装任务",
    submission_unknown: "正在确认提交结果",
    queued: "正在排队",
    running:
      job.action === "devices"
        ? "正在读取测试机"
        : job.selection?.configuration === "Release"
          ? "正在准备 Ad Hoc 测试包并安装"
          : "正在校验 IPA 并安装到测试机",
    complete: job.action === "devices" ? "已刷新" : "已安装并核对版本",
    failed: "安装失败",
    unconfirmed: "安装结果尚未确认",
  }[job.state];
}
