import type { QaHubDesktopBridge } from "./bridge-types.js";

declare global {
  interface Window {
    readonly qaHubDesktop?: QaHubDesktopBridge;
  }
}

export {};
