import assert from "node:assert/strict";
import test from "node:test";
import { applyWindowAction } from "../src/window-actions.js";

function target() {
  const calls: string[] = [];
  return {
    calls,
    maximized: false,
    fullScreen: false,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    isFullScreen() {
      return this.fullScreen;
    },
    setFullScreen(value: boolean) {
      this.fullScreen = value;
      calls.push("fullscreen");
    },
    isMaximized() {
      return this.maximized;
    },
    minimize() {
      calls.push("minimize");
    },
    maximize() {
      this.maximized = true;
      calls.push("maximize");
    },
    unmaximize() {
      this.maximized = false;
      calls.push("unmaximize");
    },
    close() {
      calls.push("close");
    },
  };
}
test("window controls use the live native state, including fullscreen", () => {
  const window = target();
  for (let i = 0; i < 4; i++) assert.equal(applyWindowAction(window, "toggle-maximize"), true);
  window.fullScreen = true;
  applyWindowAction(window, "toggle-maximize");
  applyWindowAction(window, "minimize");
  applyWindowAction(window, "close");
  assert.deepEqual(window.calls, [
    "maximize",
    "unmaximize",
    "maximize",
    "unmaximize",
    "fullscreen",
    "minimize",
    "close",
  ]);
  assert.equal(window.fullScreen, false);
});
test("window actions reject arbitrary commands, missing and destroyed windows", () => {
  const window = target();
  for (const input of ["quit", "destroy", "maximize", {}, null, ["close"]])
    assert.equal(applyWindowAction(window, input), false);
  assert.equal(applyWindowAction(null, "close"), false);
  window.destroyed = true;
  assert.equal(applyWindowAction(window, "close"), false);
  assert.deepEqual(window.calls, []);
});
