import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { AppUpdater } from "electron-updater";

import { DesktopUpdateController } from "../src/update-controller.js";

class FakeUpdater extends EventEmitter {
  checks = 0;
  installs = 0;

  async checkForUpdates(): Promise<null> {
    this.checks += 1;
    return null;
  }

  quitAndInstall(): void {
    this.installs += 1;
  }
}

test("desktop updater reports automatic download progress and installs only when ready", async () => {
  const fake = new FakeUpdater();
  const controller = new DesktopUpdateController({
    updater: fake as unknown as AppUpdater,
    currentVersion: "1.0.0",
    enabled: true,
    now: () => new Date("2026-08-27T08:00:00.000Z"),
  });

  await controller.checkForUpdates();
  assert.equal(fake.checks, 1);
  assert.equal(controller.status.phase, "checking");

  fake.emit("update-available", { version: "1.1.0" });
  fake.emit("download-progress", { percent: 48.46 });
  assert.deepEqual(controller.status, {
    phase: "downloading",
    currentVersion: "1.0.0",
    availableVersion: "1.1.0",
    progressPercent: 48.5,
    checkedAt: null,
    errorCode: null,
  });
  assert.equal(controller.installUpdate(), false);

  fake.emit("update-downloaded", { version: "1.1.0" });
  assert.equal(controller.status.phase, "downloaded");
  assert.equal(controller.status.checkedAt, "2026-08-27T08:00:00.000Z");
  assert.equal(controller.installUpdate(), true);
  assert.equal(fake.installs, 1);
  assert.equal(controller.status.phase, "installing");
});

test("desktop updater stays disabled outside a packaged Windows application", async () => {
  const controller = new DesktopUpdateController({
    updater: null,
    currentVersion: "1.0.0",
    enabled: false,
  });
  assert.equal((await controller.checkForUpdates()).phase, "disabled");
  assert.equal(controller.installUpdate(), false);
});
