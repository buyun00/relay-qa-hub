const MAX_HIERARCHY_SCAN_NODES = 5_000;
const MAX_RENDERED_PAGE_NODES = 220;
const MAX_PAGE_ROOTS = 8;
const MAX_RECENT_ERRORS = 10;

type JsonRecord = Record<string, unknown>;

export interface PocoUiNode {
  readonly name: string;
  readonly type: string | null;
  readonly instanceId: number | null;
  readonly path: string;
  readonly components: readonly string[];
  readonly clickable: boolean;
  readonly runtimeText: string | null;
  readonly visuals: readonly string[];
  readonly children: readonly PocoUiNode[];
}

export interface PocoHierarchySummary {
  readonly totalNodes: number;
  readonly visibleNodes: number;
  readonly maxDepth: number;
  readonly scanTruncated: boolean;
  readonly renderTruncated: boolean;
  readonly pageRoots: readonly PocoUiNode[];
}

export interface UnitySnapshotPage {
  readonly name: string;
  readonly prefab: string | null;
  readonly layer: string | null;
  readonly path: string | null;
  readonly sortingOrder: number | null;
  readonly rootInstanceId: number | null;
}

export interface UnityRecentError {
  readonly occurredAtUnixMs: number | null;
  readonly level: "error" | "exception" | "assert" | "warning" | "unknown";
  readonly message: string;
  readonly stackTrace: string | null;
  readonly repeatCount: number;
}

export interface UnitySnapshotSummary {
  readonly status: string | null;
  readonly capturedAtUnixMs: number | null;
  readonly scene: string | null;
  readonly appVersion: string | null;
  readonly unityVersion: string | null;
  readonly warnings: readonly string[];
  readonly activePages: readonly UnitySnapshotPage[];
  readonly recentErrorsAvailable: boolean;
  readonly recentErrors: readonly UnityRecentError[];
  readonly recentErrorWindowMs: number | null;
  readonly droppedErrorCount: number;
}

interface HierarchyCandidate {
  readonly value: JsonRecord;
  readonly path: readonly string[];
  readonly strong: boolean;
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function boundedText(value: unknown, maxLength = 512): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0) return null;
  return text.slice(0, maxLength);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function secondsToMillis(value: unknown): number | null {
  const seconds = finiteNumber(value);
  return seconds === null ? null : seconds * 1_000;
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  const parsed = finiteNumber(value);
  return parsed === null ? fallback : Math.max(0, Math.trunc(parsed));
}

function stringArray(value: unknown, maxItems = 32): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      const text = boundedText(item, 128);
      return text === null ? [] : [text];
    })
    .slice(0, maxItems);
}

function unwrapJson(value: unknown): unknown {
  let current = value;
  for (let index = 0; index < 2 && typeof current === "string"; index += 1) {
    try {
      current = JSON.parse(current) as unknown;
    } catch {
      return null;
    }
  }
  const record = asRecord(current);
  return record?.result ?? current;
}

function nodePayload(node: JsonRecord): JsonRecord {
  return asRecord(node.payload) ?? {};
}

function nodeName(node: JsonRecord): string {
  return boundedText(node.name, 160) ?? boundedText(nodePayload(node).name, 160) ?? "未命名节点";
}

function nodeChildren(node: JsonRecord): readonly JsonRecord[] {
  if (!Array.isArray(node.children)) return [];
  return node.children.flatMap((child) => {
    const record = asRecord(child);
    return record === null ? [] : [record];
  });
}

function nodeVisuals(payload: JsonRecord): readonly string[] {
  const values = [
    payload.texture,
    payload.sprite,
    payload.spriteName,
    payload.image,
    payload.imageName,
    payload.sourceImage,
    payload.resourcePath,
    payload.assetKey,
  ].flatMap((value) => {
    const text = boundedText(value, 320);
    return text === null ? [] : [text];
  });
  return [...new Set(values)].slice(0, 8);
}

function isVisibleNode(node: JsonRecord): boolean {
  return nodePayload(node).visible !== false;
}

function isPageCandidate(
  node: JsonRecord,
  parentName: string | null,
): { readonly candidate: boolean; readonly strong: boolean } {
  const name = nodeName(node);
  const components = stringArray(nodePayload(node).components);
  const strong = components.includes("UIForm");
  const viewComponent = components.some((component) =>
    /(?:Page|Dialog|Popup|Window|Screen|MainView|LobbyView)$/u.test(component),
  );
  const underUiLayer =
    parentName !== null && /(?:Menu|View|Popup|Dialog|Window|Panel|Floor)Layer$/iu.test(parentName);
  const prefabInstance =
    /\(Clone\)$/u.test(name) && components.some((component) => /View$/u.test(component));
  return { candidate: strong || prefabInstance || (underUiLayer && viewComponent), strong };
}

function pagePath(path: readonly string[]): string {
  return path.filter((segment) => segment !== "<Root>").join(" / ");
}

function renderPageTree(
  node: JsonRecord,
  path: readonly string[],
  budget: { remaining: number; truncated: boolean },
): PocoUiNode | null {
  if (budget.remaining <= 0) {
    budget.truncated = true;
    return null;
  }
  budget.remaining -= 1;
  const payload = nodePayload(node);
  const name = nodeName(node);
  const nextPath = [...path, name];
  const visibleChildren = nodeChildren(node).filter(isVisibleNode);
  const children: PocoUiNode[] = [];
  for (const child of visibleChildren) {
    const rendered = renderPageTree(child, nextPath, budget);
    if (rendered !== null) children.push(rendered);
  }
  return {
    name,
    type: boundedText(payload.type, 80),
    instanceId: finiteNumber(payload._instanceId),
    path: pagePath(nextPath),
    components: stringArray(payload.components, 16),
    clickable: payload.clickable === true,
    runtimeText: boundedText(payload.text, 1_024),
    visuals: nodeVisuals(payload),
    children,
  };
}

export function summarizePocoHierarchy(value: unknown): PocoHierarchySummary | null {
  const root = asRecord(unwrapJson(value));
  if (root === null) return null;

  let totalNodes = 0;
  let visibleNodes = 0;
  let maxDepth = 0;
  let scanTruncated = false;
  const candidates: HierarchyCandidate[] = [];
  const stack: Array<{
    readonly value: JsonRecord;
    readonly path: readonly string[];
    readonly depth: number;
    readonly parentName: string | null;
  }> = [{ value: root, path: [], depth: 0, parentName: null }];

  while (stack.length > 0) {
    if (totalNodes >= MAX_HIERARCHY_SCAN_NODES) {
      scanTruncated = true;
      break;
    }
    const current = stack.pop();
    if (current === undefined) break;
    totalNodes += 1;
    maxDepth = Math.max(maxDepth, current.depth);
    const name = nodeName(current.value);
    const nextPath = [...current.path, name];
    const visible = isVisibleNode(current.value);
    if (visible) {
      visibleNodes += 1;
      const page = isPageCandidate(current.value, current.parentName);
      if (page.candidate)
        candidates.push({ value: current.value, path: current.path, strong: page.strong });
    }
    const children = nodeChildren(current.value);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child === undefined) continue;
      stack.push({
        value: child,
        path: nextPath,
        depth: current.depth + 1,
        parentName: name,
      });
    }
  }

  const strongCandidates = candidates.filter((candidate) => candidate.strong);
  const selected = (strongCandidates.length > 0 ? strongCandidates : candidates).slice(
    0,
    MAX_PAGE_ROOTS,
  );
  const budget = { remaining: MAX_RENDERED_PAGE_NODES, truncated: false };
  const pageRoots = selected.flatMap((candidate) => {
    const rendered = renderPageTree(candidate.value, candidate.path, budget);
    return rendered === null ? [] : [rendered];
  });

  return {
    totalNodes,
    visibleNodes,
    maxDepth,
    scanTruncated,
    renderTruncated: budget.truncated,
    pageRoots,
  };
}

function firstArray(records: readonly unknown[]): readonly unknown[] | null {
  for (const value of records) {
    if (Array.isArray(value)) return value;
  }
  return null;
}

function readSnapshotPages(data: JsonRecord, root: JsonRecord): readonly UnitySnapshotPage[] {
  const ui = asRecord(data.ui);
  const directPages = firstArray([
    data.activePages,
    data.visiblePages,
    ui?.activePages,
    root.activePages,
  ]);
  const groupedPages = Array.isArray(ui?.groups)
    ? ui.groups.flatMap((groupValue) => {
        const group = asRecord(groupValue);
        if (group === null || !Array.isArray(group.forms)) return [];
        const groupName = boundedText(group.name, 80);
        return group.forms.flatMap((formValue) => {
          const form = asRecord(formValue);
          if (form === null || form.shown === false || form.activeInHierarchy === false) return [];
          return [{ ...form, layer: boundedText(form.layer, 80) ?? groupName }];
        });
      })
    : [];
  const pages = directPages ?? groupedPages;
  return pages
    .flatMap((value): UnitySnapshotPage[] => {
      const direct = boundedText(value, 160);
      if (direct !== null) {
        return [
          {
            name: direct,
            prefab: null,
            layer: null,
            path: null,
            sortingOrder: null,
            rootInstanceId: null,
          },
        ];
      }
      const record = asRecord(value);
      if (record === null) return [];
      const prefab =
        boundedText(record.prefabPath, 256) ??
        boundedText(record.prefab, 256) ??
        boundedText(record.resourcePath, 256) ??
        boundedText(record.assetKey, 256);
      const name =
        boundedText(record.name, 160) ??
        boundedText(record.pageName, 160) ??
        boundedText(record.prefabName, 160) ??
        boundedText(record.instanceName, 160) ??
        prefab?.split(/[\\/]/u).at(-1) ??
        null;
      if (name === null) return [];
      return [
        {
          name,
          prefab,
          layer: boundedText(record.layer, 80),
          path: boundedText(record.hierarchyPath, 512) ?? boundedText(record.path, 512),
          sortingOrder: finiteNumber(record.sortingOrder) ?? finiteNumber(record.siblingIndex),
          rootInstanceId: finiteNumber(record.rootInstanceId),
        },
      ];
    })
    .slice(0, MAX_PAGE_ROOTS);
}

function normalizeLogLevel(value: unknown): UnityRecentError["level"] {
  const level = boundedText(value, 32)?.toLowerCase();
  if (level === "error") return "error";
  if (level === "exception") return "exception";
  if (level === "assert") return "assert";
  if (level === "warning" || level === "warn") return "warning";
  return "unknown";
}

function timestampUnixMs(record: JsonRecord): number | null {
  const numeric =
    finiteNumber(record.occurredAtUnixMs) ??
    finiteNumber(record.timestampUnixMs) ??
    finiteNumber(record.timeUnixMs) ??
    finiteNumber(record.lastAtUnixMs) ??
    finiteNumber(record.firstAtUnixMs);
  if (numeric !== null) return numeric;
  const iso = boundedText(record.occurredAt, 80) ?? boundedText(record.timestamp, 80);
  if (iso === null) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function readRecentErrors(values: readonly unknown[]): readonly UnityRecentError[] {
  return values
    .flatMap((value): UnityRecentError[] => {
      const record = asRecord(value);
      if (record === null) return [];
      const message = boundedText(record.message, 1_024) ?? boundedText(record.condition, 1_024);
      if (message === null) return [];
      return [
        {
          occurredAtUnixMs: timestampUnixMs(record),
          level: normalizeLogLevel(record.level ?? record.type ?? record.logType),
          message,
          stackTrace: boundedText(record.stackTrace, 4_096) ?? boundedText(record.stack, 4_096),
          repeatCount: Math.max(
            1,
            nonNegativeInteger(record.repeatCount ?? record.count ?? record.occurrences, 1),
          ),
        },
      ];
    })
    .slice(0, MAX_RECENT_ERRORS);
}

export function summarizeUnitySnapshot(value: unknown): UnitySnapshotSummary | null {
  const root = asRecord(unwrapJson(value));
  if (root === null) return null;
  const data = asRecord(root.data) ?? {};
  const diagnostics = asRecord(data.diagnostics);
  const recentErrorsSource = firstArray([
    data.recentErrors,
    diagnostics?.recentErrors,
    root.recentErrors,
  ]);
  return {
    status: boundedText(root.status, 40),
    capturedAtUnixMs: finiteNumber(root.capturedAtUnixMs),
    scene: boundedText(data.scene, 160),
    appVersion: boundedText(data.appVersion, 80),
    unityVersion: boundedText(data.unityVersion, 80),
    warnings: stringArray(root.warnings, 16),
    activePages: readSnapshotPages(data, root),
    recentErrorsAvailable: recentErrorsSource !== null,
    recentErrors: readRecentErrors(recentErrorsSource ?? []),
    recentErrorWindowMs:
      finiteNumber(data.recentErrorWindowMs) ??
      finiteNumber(data.errorWindowMs) ??
      finiteNumber(diagnostics?.recentErrorWindowMs) ??
      secondsToMillis(data.errorWindowSeconds),
    droppedErrorCount: nonNegativeInteger(data.droppedErrorCount ?? diagnostics?.droppedErrorCount),
  };
}
