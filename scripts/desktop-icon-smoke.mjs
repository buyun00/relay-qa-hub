import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Run only against the isolated desktop smoke instance on port 9333.
const output = path.resolve(process.argv[2] ?? "work/windows-3.3.0-release");
await mkdir(output, { recursive: true });
const targets = await (await fetch("http://127.0.0.1:9333/json")).json();
const target = targets.find((item) => item.type === "page" && item.url.startsWith("qa-hub://app/"));
assert.ok(target);
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let sequence = 0;
const pending = new Map();
const errors = [];
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(String(data));
  if (message.method === "Runtime.exceptionThrown")
    errors.push(message.params.exceptionDetails.text);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  clearTimeout(waiter.timer);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const delay = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
async function click(selector) {
  const point = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('Control missing');
    const rect = element.getBoundingClientRect();
    return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
  })()`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    ...point,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    ...point,
  });
  await delay();
}
async function screenshot(name) {
  const result = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(output, name + ".png"), Buffer.from(result.data, "base64"));
}
try {
  await send("Runtime.enable");
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  const nativeWindow = (action, width = 1440, height = 960) =>
    JSON.parse(
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.resolve("scripts/desktop-smoke-window.ps1"),
          "-Action",
          action,
          "-Width",
          String(width),
          "-Height",
          String(height),
        ],
        { encoding: "utf8" },
      ),
    );
  nativeWindow("restore");
  nativeWindow("resize");
  await delay();
  const shell = await evaluate(`(() => ({
    iconCount: document.querySelectorAll('.app-icon svg path').length,
    controls: [...document.querySelectorAll('.window-control')].map(button => ({label: button.getAttribute('aria-label'), clickable: getComputedStyle(button).getPropertyValue('-webkit-app-region') === 'no-drag'})),
    nativeOverlayHidden: navigator.windowControlsOverlay?.visible !== true,
    draggable: getComputedStyle(document.querySelector('.topbar')).getPropertyValue('-webkit-app-region') === 'drag'
  }))()`);
  assert.equal(shell.controls.length, 3);
  assert.ok(shell.controls.every((item) => item.clickable));
  assert.ok(shell.nativeOverlayHidden && shell.draggable && shell.iconCount >= 15);
  const navigation = await evaluate(
    `([...document.querySelectorAll('.nav-item .nav-icon')].map(icon => ({name:icon.dataset.icon,color:getComputedStyle(icon).color,path:icon.querySelector('path').getAttribute('d')})))`,
  );
  assert.equal(new Set(navigation.map((icon) => icon.color)).size, 5);
  assert.notEqual(
    navigation[0].path,
    navigation[1].path,
    "Workbench and overview must have distinct shapes",
  );
  const navigationSelection = [];
  for (const name of ["overview", "dashboard"]) {
    await click(`.nav-item:has([data-icon="${name}"])`);
    await delay(700);
    navigationSelection.push(
      await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('.nav-item')];
      const selected = buttons.filter(button => button.getAttribute('aria-current') === 'page');
      const button = selected[0];
      const style = getComputedStyle(button);
      return {name:button.querySelector('.nav-icon').dataset.icon,count:selected.length,background:style.backgroundColor,color:style.color,inactiveBackground:getComputedStyle(buttons.find(item => item !== button)).backgroundColor};
    })()`),
    );
  }
  assert.ok(
    navigationSelection.every(
      (item) =>
        item.count === 1 &&
        item.background === "rgb(23, 43, 33)" &&
        item.color === "rgb(255, 255, 255)" &&
        item.inactiveBackground === "rgba(0, 0, 0, 0)",
    ),
    JSON.stringify(navigationSelection),
  );
  const minimizeHover = await evaluate(
    `(() => {const r=document.querySelector('[aria-label="最小化"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
  );
  const minimizeSample = evaluate(
    `new Promise(resolve => {const heights=[];const frame=()=>{heights.push(document.querySelector('[data-icon="minimize"] path').getBBox().height);if(heights.length<40)setTimeout(frame,20);else resolve(heights)};frame()})`,
  );
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...minimizeHover });
  const minimizeHeights = await minimizeSample;
  assert.ok(
    minimizeHeights.every((height) => height < 0.01),
    "Minimize must remain a horizontal line throughout its animation",
  );
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 80 });
  console.error("Testing morph geometry");
  const frames = await evaluate(`new Promise(resolve => {
    const values = [];
    const button = document.querySelector('.topbar [aria-label="刷新"]');
    const frame = () => { values.push(document.querySelector('.topbar [data-icon="refresh"] path').getAttribute('d')); if (values.length < 40) setTimeout(frame, 20); else resolve([...new Set(values)]); };
    frame();
    button.focus();
  })`);
  assert.ok(frames.length > 3, "Keyboard focus must morph geometry over multiple frames");
  await evaluate(`document.querySelector('.topbar [aria-label="刷新"]').blur()`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 80 });
  const selection = [];
  for (const status of ["pending", "inProgress", "verification", "closed"]) {
    await click(`.summary-card[data-status="${status}"]`);
    selection.push(
      await evaluate(`(() => {
      const cards = [...document.querySelectorAll('.summary-card')];
      const selected = cards.filter(card => card.getAttribute('aria-pressed') === 'true');
      const card = selected[0];
      return {status:card.dataset.status, count:selected.length, badge:getComputedStyle(card.querySelector('.summary-selection')).visibility, background:getComputedStyle(card).backgroundColor, border:getComputedStyle(card).borderColor, icon:getComputedStyle(card.querySelector('.summary-icon')).color, iconBackground:getComputedStyle(card.querySelector('.summary-icon')).backgroundColor, allIcons:cards.map(item=>getComputedStyle(item.querySelector('.summary-icon')).color), inactiveBackground:getComputedStyle(cards.find(c=>c!==card)).backgroundColor};
    })()`),
    );
  }
  assert.ok(
    selection.every(
      (item) =>
        item.count === 1 &&
        item.badge === "visible" &&
        item.border === item.icon &&
        item.background === "rgb(255, 255, 255)" &&
        item.inactiveBackground === "rgb(255, 255, 255)" &&
        item.iconBackground === "rgba(0, 0, 0, 0)" &&
        new Set(item.allIcons).size === 4,
    ),
    JSON.stringify(selection),
  );
  assert.equal(new Set(selection.map((item) => item.border)).size, 4);
  await click('.summary-card[data-status="pending"]');
  const list = await evaluate(
    `([...document.querySelectorAll('.bug-row')].map(row => ({priority:row.querySelector('.priority').textContent,color:getComputedStyle(row.querySelector('.priority')).backgroundColor,fixer:row.querySelector('.bug-fixer').textContent,person:row.querySelector('.person-cell').innerText})))`,
  );
  assert.ok(
    list.length > 0 &&
      list.every(
        (row) =>
          row.color !== "rgba(0, 0, 0, 0)" &&
          row.fixer.includes("修复") &&
          row.person.trim().length > 0,
      ),
  );
  await screenshot("icons-workbench");
  await click(".utility-card.compact-card");
  const modalControls = await evaluate(`!!document.querySelector('dialog[open] .window-controls')`);
  assert.ok(modalControls, "Window actions must stay usable in modal dialogs");
  await click('[aria-label="最大化"]');
  assert.ok(
    await evaluate(
      `window.qaHubDesktop.getWindowState().then(state => state.maximized && !!document.querySelector('dialog[open]'))`,
    ),
  );
  await click('[aria-label="还原窗口"]');
  await click('[aria-label="关闭设置"]');
  assert.equal(await evaluate(`!!document.querySelector('dialog[open]')`), false);
  await click('[aria-label="最大化"]');
  const maximized = await evaluate(
    `(async () => ({state:await window.qaHubDesktop.getWindowState(), square:document.querySelector('.desktop-window').classList.contains('is-square'), pressed:document.querySelector('.window-maximize').getAttribute('aria-pressed'), icon:document.querySelector('.window-maximize .app-icon').dataset.icon}))()`,
  );
  assert.ok(
    maximized.state.maximized &&
      maximized.square &&
      maximized.pressed === "true" &&
      maximized.icon === "restore",
  );
  await click('[aria-label="还原窗口"]');
  assert.equal(
    await evaluate(`window.qaHubDesktop.getWindowState().then(state => state.maximized)`),
    false,
  );
  nativeWindow("resize", 960, 640);
  await delay();
  const compact = await evaluate(
    `({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,controlsOverlap:document.querySelector('.topbar [aria-label="刷新"]').getBoundingClientRect().right>=document.querySelector('.window-controls').getBoundingClientRect().left})`,
  );
  assert.ok(!compact.overflow && !compact.controlsOverlap && compact.width <= 960);
  const compactPeople = await evaluate(
    `([...document.querySelectorAll('.bug-row')].map(row => {const person=row.querySelector('.person-cell').getBoundingClientRect();const main=row.querySelector('.bug-main').getBoundingClientRect();const updated=row.querySelector('.updated-cell').getBoundingClientRect();return {personVisible:person.width>0 && person.height>0,personOverlapsTitle:person.left<main.right,updatedVisible:updated.width>0 && updated.height>0};}))`,
  );
  assert.ok(
    compactPeople.length > 0 &&
      compactPeople.every(
        (row) => row.personVisible && !row.personOverlapsTitle && row.updatedVisible,
      ),
  );
  await screenshot("icons-compact");
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await delay();
  const reduced = await evaluate(
    `({matches:matchMedia('(prefers-reduced-motion: reduce)').matches,transition:getComputedStyle(document.querySelector('.app-icon')).transitionDuration})`,
  );
  assert.ok(
    reduced.matches && reduced.transition.split(",").every((value) => parseFloat(value) <= 0.00001),
    JSON.stringify(reduced),
  );
  await click('[aria-label="最小化"]');
  const minimized = nativeWindow("measure");
  assert.equal(minimized.minimized, true);
  nativeWindow("restore");
  await delay();
  await click('[aria-label="关闭窗口"]');
  const closeToTray = await evaluate(
    `window.qaHubDesktop.getRuntimeInfo().then(info => ({bridgeAlive:!!info}))`,
  );
  closeToTray.hidden = !nativeWindow("measure").visible;
  assert.ok(closeToTray.bridgeAlive && closeToTray.hidden);
  assert.deepEqual(errors, []);
  const proof = {
    shell,
    navigation,
    navigationSelection,
    minimizeLineMaxHeight: Math.max(...minimizeHeights),
    list,
    morphFrames: frames.length,
    selection,
    modalControls,
    maximized,
    compact,
    compactPeople,
    reducedMotion: reduced,
    minimized: true,
    closeToTray,
    rendererErrors: errors,
  };
  await writeFile(path.join(output, "icon-smoke.json"), JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify(proof));
} finally {
  socket.close();
}
