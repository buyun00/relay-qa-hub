export const PWA_STATUS_EVENT = "qa-hub:pwa-status";

export type PwaStatus =
  | { readonly kind: "offline-ready" }
  | { readonly kind: "update"; readonly apply: () => void }
  | { readonly kind: "registration-error" };

export interface PwaNotice {
  readonly message: string;
  readonly tone: "info" | "warning";
}

export function getPwaNotice(status: PwaStatus): PwaNotice {
  switch (status.kind) {
    case "offline-ready":
      return {
        message: "应用壳已可离线打开；业务数据仍以服务器为准。",
        tone: "info",
      };
    case "update":
      return {
        message: "发现 QA Hub 新版本，可安全刷新应用壳。",
        tone: "info",
      };
    case "registration-error":
      return {
        message: "离线应用壳暂不可用；在线 QA 流程不受影响。",
        tone: "warning",
      };
  }
}

export function publishPwaStatus(status: PwaStatus, target: EventTarget = window): void {
  target.dispatchEvent(new CustomEvent<PwaStatus>(PWA_STATUS_EVENT, { detail: status }));
}

declare global {
  interface WindowEventMap {
    "qa-hub:pwa-status": CustomEvent<PwaStatus>;
  }
}
