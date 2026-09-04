const ACTIONS = new Set([
  "snapshot",
  "login",
  "open-first-bug",
  "open-bug-editor",
  "open-qingyu",
  "open-overview",
  "open-production",
  "select-overview-date",
  "wait-marker",
  "wait-update-ready",
  "install-update",
  "notify-packaging",
]);
const action = process.argv[2] ?? "snapshot";
if (!ACTIONS.has(action)) {
  throw new Error(
    "action must be snapshot, login, open-first-bug, open-bug-editor, open-qingyu, open-overview, select-overview-date, wait-marker, wait-update-ready, install-update, or notify-packaging",
  );
}

const marker = process.env.QA_HUB_DESKTOP_SMOKE_MARKER?.trim() ?? "";
const hasControlCharacter = (value) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
if (marker.length > 300 || hasControlCharacter(marker)) {
  throw new Error("QA_HUB_DESKTOP_SMOKE_MARKER is invalid");
}
const loginName = process.env.QA_HUB_DESKTOP_LOGIN_NAME?.trim() ?? "";
if (loginName.length > 100 || (loginName.length > 0 && hasControlCharacter(loginName))) {
  throw new Error("QA_HUB_DESKTOP_LOGIN_NAME is invalid");
}

async function target() {
  const response = await fetch("http://127.0.0.1:9333/json");
  if (!response.ok) throw new Error(`CDP target request failed: ${response.status}`);
  const targets = await response.json();
  const page = targets.find(
    (candidate) => candidate.type === "page" && candidate.url.startsWith("qa-hub://app/"),
  );
  if (!page?.webSocketDebuggerUrl) throw new Error("QA Hub CDP page target is unavailable");
  return page;
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const events = [];
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(String(event.data));
    if (typeof value.id !== "number") {
      if (value.method === "Runtime.exceptionThrown" || value.method === "Log.entryAdded") {
        events.push(value);
      }
      return;
    }
    const waiter = pending.get(value.id);
    if (waiter === undefined) return;
    pending.delete(value.id);
    if (value.error) waiter.reject(new Error(value.error.message ?? "CDP command failed"));
    else waiter.resolve(value.result);
  });
  return {
    async send(method, params = {}) {
      sequence += 1;
      const id = sequence;
      const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return response;
    },
    events() {
      return events.slice();
    },
    close() {
      socket.close();
    },
  };
}

const snapshotExpression = `
  (async () => {
    const bodyText = document.body?.innerText ?? "";
    const evidenceImages = [...document.querySelectorAll(".evidence-grid img")];
    const detailError = document.querySelector(".detail-load-error, .detail-inline-warning");
    const status = window.qaHubDesktop === undefined
      ? null
      : await window.qaHubDesktop.getConnectionStatus();
    const updateState = window.qaHubDesktop === undefined
      ? null
      : await window.qaHubDesktop.getUpdateState();
    return {
      url: location.href,
      title: document.title,
      appReady: document.querySelector(".app-shell") !== null,
      loginVisible: document.querySelector(".auth-form") !== null,
      authUnavailable: document.querySelector(".auth-status h1") !== null,
      bugRowCount: document.querySelectorAll(".bug-row").length,
      workbenchLoading: document.querySelector(".loading-row") !== null,
      workbenchEmpty: document.querySelector(".empty-state") !== null,
      workbenchErrorText: document.querySelector(".error-banner")?.textContent?.trim() ?? null,
      detailOpen: document.querySelector(".detail-modal") !== null,
      detailLoadingVisible: document.querySelector(".detail-loading") !== null,
      detailErrorText: detailError?.textContent?.trim() ?? null,
      detailEditTriggerVisible: document.querySelector(".detail-edit-trigger") !== null,
      detailDeleteTriggerVisible: document.querySelector(".detail-actions .danger-button") !== null,
      detailEditorVisible: document.querySelector(".detail-edit-form") !== null,
      detailEditorImageInputVisible:
        document.querySelector('.detail-edit-form input[type="file"]') !== null,
      detailEditorFieldCount: document.querySelectorAll(
        '.detail-edit-form input:not([type="file"]), .detail-edit-form textarea, .detail-edit-form select',
      ).length,
      qingyuModalVisible: document.querySelector('.qingyu-modal[aria-label="从轻语导入 Bug"]') !== null,
      qingyuQrVisible: document.querySelector(".qingyu-login-panel svg") !== null,
      qingyuWorkspaceVisible:
        document.querySelector(".qingyu-connected") !== null &&
        document.querySelector(".qingyu-defect-list") !== null,
      qingyuErrorText: document.querySelector(".qingyu-modal .error-banner")?.textContent?.trim() ?? null,
      evidenceImageCount: evidenceImages.length,
      evidenceLoadedCount: evidenceImages.filter((image) => image.complete && image.naturalWidth > 0).length,
      summaryLabels: [...document.querySelectorAll(".summary-label")].map((node) => node.textContent?.trim() ?? ""),
      pocoRegionVisible: document.querySelector(".poco-context-section") !== null,
      pocoRegionText: document.querySelector(".poco-context-section")?.textContent?.trim() ?? null,
      overviewVisible: document.querySelector(".overview-page") !== null,
      overviewLoading: [...document.querySelectorAll(".overview-empty")].some((node) =>
        (node.textContent ?? "").includes("正在读取")),
      overviewErrorText: document.querySelector(".overview-page .error-banner")?.textContent?.trim() ?? null,
      overviewRowCount: document.querySelectorAll(".overview-grid:not(.overview-grid-head)").length,
      overviewOwnerSelectCount: document.querySelectorAll(".overview-owner-cell select").length,
      overviewVerifierSelectCount: document.querySelectorAll(".overview-verifier-cell select").length,
      overviewPrioritySelectCount: document.querySelectorAll(".overview-key-priority-select").length,
      overviewPriorityLabelCount: document.querySelectorAll(".overview-key-priority > small").length,
      overviewDisplayedKeys: [...document.querySelectorAll(".overview-key-number")].map((node) =>
        node.textContent?.trim() ?? ""),
      overviewTitleSupplementCount: document.querySelectorAll(".overview-title > small").length,
      overviewWrappedTitleCount: [...document.querySelectorAll(".overview-title > strong")].filter(
        (node) => getComputedStyle(node).whiteSpace !== "nowrap").length,
      overviewLargeTitleCount: [...document.querySelectorAll(".overview-title > strong")].filter(
        (node) => Number.parseFloat(getComputedStyle(node).fontSize) >= 15).length,
      overviewColumnResizerCount: document.querySelectorAll(".overview-column-resizer").length,
      overviewHeaders: [...document.querySelectorAll(".overview-grid-head > span")].map((node) =>
        node.textContent?.trim() ?? ""),
      overviewUnassignedFilterAvailable: [...document.querySelectorAll(".overview-toolbar option")].some(
        (option) => option.value === "unassigned" && (option.textContent ?? "").includes("未分配")),
      overviewDateNavVisible: document.querySelector(".overview-date-nav") !== null,
      overviewDatePageCount: document.querySelectorAll(".overview-date-pages .overview-date-page").length,
      overviewDatePickerVisible: document.querySelector('.overview-date-picker input[type="date"]') !== null,
      overviewSelectedDate: document.querySelector(".overview-date-picker input")?.value ?? "",
      overviewActiveDatePageLabel: document.querySelector(".overview-date-page.is-active span")?.textContent?.trim() ?? null,
      overviewAllDateCount: Number.parseInt(
        document.querySelector(".overview-date-nav > .overview-date-page b")?.textContent ?? "0",
        10,
      ),
      overviewRowDateKeys: [...document.querySelectorAll(".overview-grid[data-created-date]")].map(
        (node) => node.getAttribute("data-created-date") ?? ""),
      markerVisible: ${JSON.stringify(marker)}.length > 0 && bodyText.includes(${JSON.stringify(marker)}),
      desktopConnection: status,
      desktopPackagingBridgeAvailable: typeof window.qaHubDesktop?.notifyPackaging === "function" && typeof window.qaHubDesktop?.onOpenPackaging === "function",
      desktopUpdate: updateState,
      visibilityState: document.visibilityState
    };
  })()
`;

async function snapshot(client) {
  const result = await client.send("Runtime.evaluate", {
    expression: snapshotExpression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error("renderer snapshot evaluation failed");
  return result.result?.value;
}

const page = await target();
const client = await connect(page.webSocketDebuggerUrl);
try {
  await client.send("Runtime.enable");
  await client.send("Log.enable");
  if (action === "login") {
    if (loginName.length === 0) throw new Error("QA_HUB_DESKTOP_LOGIN_NAME is required");
    const result = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const input = document.querySelector("#login-name");
        const form = document.querySelector(".auth-form");
        if (!(input instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, ${JSON.stringify(loginName)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
        form.requestSubmit();
        return true;
      })()`,
      returnByValue: true,
    });
    if (result.result?.value !== true) throw new Error("desktop login form is unavailable");
    const deadline = Date.now() + 10_000;
    let current;
    do {
      current = await snapshot(client);
      const workbenchSettled =
        current?.appReady === true &&
        current?.workbenchLoading === false &&
        (current?.bugRowCount > 0 ||
          current?.workbenchEmpty === true ||
          current?.workbenchErrorText !== null);
      if (workbenchSettled) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    process.stdout.write(`${JSON.stringify({ action, snapshot: current })}\n`);
    if (
      current?.appReady !== true ||
      current?.workbenchLoading === true ||
      current?.workbenchErrorText !== null
    ) {
      process.exitCode = 1;
    }
  } else if (action === "open-production") {
    await client.send("Runtime.evaluate", {
      expression: `document.querySelectorAll('.nav-item').forEach(button => { if (button.textContent.includes('制作任务')) button.click(); })`,
    });
    const deadline = Date.now() + 20_000;
    let production;
    do {
      const result = await client.send("Runtime.evaluate", {
        expression: `(() => {
          const page = document.querySelector('.production-page');
          return { visible: Boolean(page && !page.closest('[hidden]')), rowCount: page?.querySelectorAll('tbody tr').length ?? 0, error: page?.querySelector('.error-banner')?.textContent?.trim() ?? null, loading: page?.textContent.includes('正在连接制作服务') ?? true };
        })()`, returnByValue: true,
      });
      production = result.result?.value;
      if (production?.visible && !production.loading && !production.error) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    if (!production?.visible || production.loading || production.error) throw new Error(`Production page failed: ${JSON.stringify(production)}`);
    const create = await client.send("Runtime.evaluate", {
      expression: `(async () => {
        document.querySelectorAll('.production-header button').forEach(button => { if (button.textContent.includes('新建')) button.click(); });
        await new Promise(resolve => setTimeout(resolve, 100));
        const modal = document.querySelector('.production-modal');
        const result = { createVisible: modal !== null, repository: modal?.querySelector('.production-repository')?.textContent ?? '', filePicker: modal?.querySelector('input[type=file]') !== null, advancedOptions: modal?.querySelector('.production-advanced') !== null };
        modal?.querySelector('.production-modal-heading button')?.click();
        return result;
      })()`, awaitPromise: true, returnByValue: true,
    });
    if (!create.result?.value?.createVisible || !create.result.value.filePicker || !create.result.value.advancedOptions) throw new Error("Production creation form is incomplete");
    process.stdout.write(`${JSON.stringify({ action, production: { ...production, ...create.result.value } })}\n`);
  } else if (action === "open-first-bug") {
    const result = await client.send("Runtime.evaluate", {
      expression: `(async () => {
        let row = document.querySelector(".bug-row");
        if (!row) {
          const scope = document.querySelector(".person-filter select");
          if (scope instanceof HTMLSelectElement) {
            scope.value = "team";
            scope.dispatchEvent(new Event("change", { bubbles: true }));
            for (let attempt = 0; attempt < 50 && !row; attempt++) {
              await new Promise(resolve => setTimeout(resolve, 200));
              row = document.querySelector(".bug-row");
            }
          }
        }
        if (!(row instanceof HTMLButtonElement)) return false;
        row.click();
        return true;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.result?.value !== true) throw new Error("desktop bug row is unavailable");
    const deadline = Date.now() + 10_000;
    let current;
    do {
      current = await snapshot(client);
      if (
        current?.detailOpen === true &&
        current?.detailLoadingVisible === false &&
        current?.detailErrorText === null
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    process.stdout.write(`${JSON.stringify({ action, snapshot: current })}\n`);
    if (
      current?.detailOpen !== true ||
      current?.detailLoadingVisible === true ||
      current?.detailErrorText !== null
    ) {
      process.exitCode = 1;
    }
  } else if (action === "open-bug-editor") {
    const result = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const button = document.querySelector(".detail-edit-trigger");
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`,
      returnByValue: true,
    });
    if (result.result?.value !== true) throw new Error("desktop Bug detail editor is unavailable");
    const deadline = Date.now() + 5_000;
    let current;
    do {
      current = await snapshot(client);
      if (current?.detailEditorVisible === true && current?.detailEditorFieldCount === 6) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    process.stdout.write(`${JSON.stringify({ action, snapshot: current })}\n`);
    if (current?.detailEditorVisible !== true || current?.detailEditorFieldCount !== 6) {
      process.exitCode = 1;
    }
  } else if (action === "open-qingyu") {
    const result = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const button = [...document.querySelectorAll("button")].find(
          (candidate) => (candidate.textContent ?? "").trim() === "从轻语导入",
        );
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`,
      returnByValue: true,
    });
    if (result.result?.value !== true)
      throw new Error("desktop Qingyu import action is unavailable");
    const deadline = Date.now() + 10_000;
    let current;
    do {
      current = await snapshot(client);
      if (
        current?.appReady !== true ||
        current?.qingyuQrVisible === true ||
        current?.qingyuWorkspaceVisible === true ||
        current?.qingyuErrorText !== null
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    const diagnostics = client
      .events()
      .slice(-10)
      .map((event) => ({ method: event.method, params: event.params }));
    process.stdout.write(`${JSON.stringify({ action, snapshot: current, diagnostics })}\n`);
    if (current?.appReady !== true || current?.qingyuModalVisible !== true) {
      process.exitCode = 1;
    } else {
      await client.send("Runtime.evaluate", {
        expression: `(() => {
          const button = document.querySelector(".qingyu-modal .modal-head button");
          if (!(button instanceof HTMLButtonElement)) return false;
          button.click();
          return true;
        })()`,
        returnByValue: true,
      });
    }
  } else if (action === "open-overview" || action === "select-overview-date") {
    const navigation = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const button = [...document.querySelectorAll(".nav-item")].find(
          (candidate) => (candidate.textContent ?? "").includes("总览"),
        );
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`,
      returnByValue: true,
    });
    if (navigation.result?.value !== true)
      throw new Error("desktop overview navigation is unavailable");
    const deadline = Date.now() + 10_000;
    let current;
    do {
      current = await snapshot(client);
      if (
        current?.overviewVisible === true &&
        current?.overviewLoading === false &&
        current?.overviewErrorText === null
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    let selection = null;
    if (
      action === "select-overview-date" &&
      current?.overviewVisible === true &&
      current?.overviewLoading === false &&
      current?.overviewErrorText === null
    ) {
      const selected = await client.send("Runtime.evaluate", {
        expression: `(() => {
          const button = document.querySelector(".overview-date-pages .overview-date-page");
          if (!(button instanceof HTMLButtonElement)) return null;
          const date = button.getAttribute("data-overview-date") ?? "";
          const expectedCount = Number.parseInt(button.querySelector("b")?.textContent ?? "0", 10);
          button.click();
          return { date, expectedCount };
        })()`,
        returnByValue: true,
      });
      selection = selected.result?.value ?? null;
      const selectionDeadline = Date.now() + 5_000;
      do {
        current = await snapshot(client);
        if (
          current?.overviewSelectedDate.length > 0 &&
          current?.overviewRowDateKeys.every((date) => date === current.overviewSelectedDate)
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < selectionDeadline);
    }
    process.stdout.write(`${JSON.stringify({ action, selection, snapshot: current })}\n`);
    if (
      current?.overviewVisible !== true ||
      current?.overviewLoading === true ||
      current?.overviewErrorText !== null ||
      (action === "select-overview-date" &&
        (selection === null ||
          current?.overviewSelectedDate.length === 0 ||
          current?.overviewSelectedDate !== selection.date ||
          current?.overviewRowCount !== selection.expectedCount ||
          current?.overviewRowDateKeys.some((date) => date !== current.overviewSelectedDate)))
    ) {
      process.exitCode = 1;
    }
  } else if (action === "wait-update-ready") {
    const deadline = Date.now() + 120_000;
    let current;
    do {
      current = await snapshot(client);
      if (current?.desktopUpdate?.status === "ready") break;
      if (current?.desktopUpdate?.status === "error") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    process.stdout.write(`${JSON.stringify({ action, snapshot: current })}\n`);
    if (current?.desktopUpdate?.status !== "ready") process.exitCode = 1;
  } else if (action === "notify-packaging") {
    const result = await client.send("Runtime.evaluate", {
      expression: `(async () => {
        const id = "build-" + Math.floor(Date.now() / 1000) + "-finished";
        const notice = { id, kind: "success", title: "打包系统通知验证", body: "这是一条系统通知验证消息，未触发真实构建。" };
        const accepted = await window.qaHubDesktop.notifyPackaging(notice);
        const duplicate = await window.qaHubDesktop.notifyPackaging(notice);
        return { id, accepted, duplicate, inAppNotificationCount: document.querySelectorAll(".package-notifications").length };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    const delivery = result.result?.value;
    if (!delivery?.accepted || delivery.duplicate || delivery.inAppNotificationCount !== 0)
      throw new Error("Native packaging notification delivery or deduplication failed");
    process.stdout.write(`${JSON.stringify({ action, delivery })}\n`);
  } else if (action === "install-update") {
    const result = await client.send("Runtime.evaluate", {
      expression: "window.qaHubDesktop?.installUpdate() ?? Promise.resolve(false)",
      awaitPromise: true,
      returnByValue: true,
    });
    process.stdout.write(
      `${JSON.stringify({ action, accepted: result.result?.value === true })}\n`,
    );
    if (result.result?.value !== true) process.exitCode = 1;
  } else if (action === "wait-marker") {
    if (marker.length === 0) throw new Error("QA_HUB_DESKTOP_SMOKE_MARKER is required");
    const deadline = Date.now() + 20_000;
    let current;
    do {
      current = await snapshot(client);
      if (current?.markerVisible === true) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    process.stdout.write(`${JSON.stringify({ action, snapshot: current })}\n`);
    if (current?.markerVisible !== true) process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify({ action, snapshot: await snapshot(client) })}\n`);
  }
} finally {
  client.close();
}
