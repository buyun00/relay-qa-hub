import { afterEach, expect, it, vi } from "vitest";
import {
  notifyPackagingSystem,
  requestPackagingNotificationPermission,
} from "./packaging-notifications";

const notice = {
  id: "build-10141-finished",
  kind: "success" as const,
  title: "打包完成",
  body: "下载列表已刷新",
};
afterEach(() => vi.unstubAllGlobals());

function browser(permission: NotificationPermission = "granted", secure = true) {
  const created: FakeNotification[] = [];
  class FakeNotification {
    static permission = permission;
    static requestPermission = vi.fn().mockResolvedValue("granted");
    onclick: (() => void) | null = null;
    close = vi.fn();
    readonly title: string;
    readonly options: NotificationOptions;
    constructor(title: string, options: NotificationOptions) {
      this.title = title;
      this.options = options;
      created.push(this);
    }
  }
  const environment = {
    isSecureContext: secure,
    Notification: FakeNotification,
    focus: vi.fn(),
    qaHubDesktop: undefined as unknown,
  };
  vi.stubGlobal("window", environment);
  vi.stubGlobal("Notification", FakeNotification);
  return { created, environment, FakeNotification };
}

it("uses only Electron's system notification bridge, including a declined delivery", async () => {
  const { environment, created, FakeNotification } = browser("default");
  const native = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  environment.qaHubDesktop = { notifyPackaging: native };
  requestPackagingNotificationPermission();
  expect(await notifyPackagingSystem(notice, vi.fn())).toBe(true);
  expect(await notifyPackagingSystem(notice, vi.fn())).toBe(false);
  expect(native).toHaveBeenCalledWith(notice);
  expect(created).toHaveLength(0);
  expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
});

it("routes a permitted browser system notification click back to packaging", async () => {
  const { created, environment } = browser();
  const open = vi.fn();
  expect(await notifyPackagingSystem(notice, open)).toBe(true);
  expect(created[0]?.options.tag).toBe(notice.id);
  expect(created[0]?.title).toContain("OZDQP");
  created[0]?.onclick?.();
  expect(environment.focus).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledOnce();
  expect(created[0]?.close).toHaveBeenCalledOnce();
});

it("requests permission only from the explicit gesture helper and respects denied or insecure contexts", async () => {
  const allowed = browser("default");
  expect(await notifyPackagingSystem(notice, vi.fn())).toBe(false);
  expect(allowed.FakeNotification.requestPermission).not.toHaveBeenCalled();
  requestPackagingNotificationPermission();
  expect(allowed.FakeNotification.requestPermission).toHaveBeenCalledOnce();
  for (const [permission, secure] of [
    ["denied", true],
    ["default", false],
  ] as const) {
    const blocked = browser(permission, secure);
    requestPackagingNotificationPermission();
    expect(await notifyPackagingSystem(notice, vi.fn())).toBe(false);
    expect(blocked.created).toHaveLength(0);
    expect(blocked.FakeNotification.requestPermission).not.toHaveBeenCalled();
  }
});
