import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import ts from "typescript";

// Static inventory only: do not import or execute application code, contact an API,
// read production configuration, install packages, or infer a test pass.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, "docs/evidence/project-components");
const jsonPath = path.join(output, "coverage-matrix.json");
const markdownPath = path.join(output, "coverage-matrix.md");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const relative = (value) => path.relative(root, value).replaceAll("\\", "/");
const compact = (value, limit = 180) => value.replace(/\s+/gu, " ").trim().slice(0, limit);
const surfaces = ["apk", "exe", "web", "http", "server_mcp", "local_mcp"];
const surfaceLabels = ["APK", "EXE", "Web", "HTTP API", "server MCP", "local MCP"];
const sharedDesktopCatalog =
  /sharedApi:\s*true/u.test(fs.readFileSync(path.join(root, "apps/desktop/src/main.ts"), "utf8")) &&
  /this\.options\.sharedApi\s*\?\s*this\.sharedDefinitions/u.test(
    fs.readFileSync(path.join(root, "apps/desktop/src/mcp-api.ts"), "utf8"),
  );
const serverToolSurfaces = sharedDesktopCatalog ? ["server_mcp", "local_mcp"] : ["server_mcp"];
let previous = { items: [] };
if (fs.existsSync(jsonPath))
  previous = JSON.parse(fs.readFileSync(jsonPath, "utf8").replace(/^\uFEFF/u, ""));
const priorItems = new Map((previous.items ?? []).map((item) => [item.id, item]));
const items = [];
const idCounts = new Map();
const files = [];
const sourceRoots = [
  "apps/api/src",
  "apps/web/src",
  "apps/desktop/src",
  "apps/android/app/src/main",
  "apps/worker/src",
  "packages/domain/src",
];
function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const file = path.join(directory, item.name);
    if (item.isDirectory()) walk(file);
    else if (/\.(?:tsx?|kt)$/u.test(item.name) && !/\.(?:test|spec)\.tsx?$/u.test(item.name))
      files.push(file);
  }
}
for (const directory of sourceRoots) walk(path.join(root, directory));
files.sort();
const sourceHashes = Object.fromEntries(
  files.map((file) => [relative(file), hash(fs.readFileSync(file))]),
);
const program = ts.createProgram(
  files.filter((file) => /\.tsx?$/u.test(file)),
  {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.ReactJSX,
    skipLibCheck: true,
    noEmit: true,
  },
);
const checker = program.getTypeChecker();
const normalizedFiles = new Set(files.map((file) => path.resolve(file).toLowerCase()));
const sourceFiles = program
  .getSourceFiles()
  .filter((file) => normalizedFiles.has(path.resolve(file.fileName).toLowerCase()));
const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ALL"]);
function initOf(node) {
  let symbol = checker.getSymbolAtLocation(node);
  if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}
function unwrap(node) {
  while (
    node &&
    (ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node))
  )
    node = node.expression;
  return node;
}
function values(input, environment = new Map(), seen = new Set()) {
  const node = unwrap(input);
  if (!node) return [];
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return [node.text];
  if (ts.isArrayLiteralExpression(node))
    return node.elements.flatMap((entry) => values(entry, environment, seen));
  if (ts.isIdentifier(node)) {
    if (environment.has(node.text)) return environment.get(node.text);
    const declaration = initOf(node);
    if (!declaration || seen.has(declaration)) return [];
    const next = new Set(seen).add(declaration);
    if (declaration.initializer) return values(declaration.initializer, environment, next);
    return [];
  }
  if (
    ts.isCallExpression(node) &&
    /^(?:Object\.freeze|Object\.seal)$/u.test(node.expression.getText())
  )
    return values(node.arguments[0], environment, seen);
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "replace"
  ) {
    const search = values(node.arguments[0], environment, seen),
      replacement = values(node.arguments[1], environment, seen);
    if (search.length === 1 && replacement.length === 1)
      return values(node.expression.expression, environment, seen).map((value) =>
        value.replace(search[0], replacement[0]),
      );
  }
  if (ts.isTemplateExpression(node)) {
    let result = [node.head.text];
    for (const span of node.templateSpans) {
      const expansions = values(span.expression, environment, seen);
      const choices = expansions.length
        ? expansions
        : [`:${compact(span.expression.getText(), 50)}`];
      result = result.flatMap((prefix) =>
        choices.map((choice) => prefix + choice + span.literal.text),
      );
    }
    return result;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = values(node.left, environment, seen),
      right = values(node.right, environment, seen);
    return left.flatMap((a) => right.map((b) => a + b));
  }
  return [];
}
function loopEnvironment(node, initial = new Map()) {
  const environment = new Map(initial);
  const ancestors = [];
  for (let cursor = node.parent; cursor; cursor = cursor.parent) ancestors.unshift(cursor);
  for (const parent of ancestors) {
    if (!ts.isForOfStatement(parent)) continue;
    const binding = ts.isVariableDeclarationList(parent.initializer)
      ? parent.initializer.declarations[0]?.name
      : parent.initializer;
    if (binding && ts.isArrayBindingPattern(binding)) {
      let array = unwrap(parent.expression);
      if (ts.isIdentifier(array)) array = unwrap(initOf(array)?.initializer);
      if (array && ts.isArrayLiteralExpression(array))
        binding.elements.forEach((entry, index) => {
          if (ts.isBindingElement(entry))
            environment.set(
              entry.name.getText(),
              array.elements.flatMap((row) => {
                const tuple = unwrap(row);
                return tuple && ts.isArrayLiteralExpression(tuple)
                  ? values(tuple.elements[index], environment)
                  : [];
              }),
            );
        });
      continue;
    }
    const name = binding?.getText();
    if (name) environment.set(name, values(parent.expression, environment));
  }
  return environment;
}
function property(node, name) {
  return node.properties?.find(
    (entry) => entry.name?.getText().replaceAll('"', "").replaceAll("'", "") === name,
  );
}
const propValue = (node, name) => {
  const prop = property(node, name);
  return prop && (ts.isShorthandPropertyAssignment(prop) ? prop.name : prop.initializer);
};
function location(node) {
  const file = node.getSourceFile();
  return {
    file: relative(file.fileName),
    line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
  };
}
function groupFor(text) {
  if (/qingyu/iu.test(text)) return "qingyu.sync";
  if (/increment-upload|upload.incremental|Uploader|UploadIncrement/iu.test(text))
    return "upload.incremental";
  if (/build.?upload|build-chains/iu.test(text)) return "build_upload.single";
  if (/production|relay|repair-attempt.*(?:dispatch|receipt)/iu.test(text))
    return "relay.production";
  if (/jenkins|packaging|PackagingPage/iu.test(text)) return "build";
  if (/project|membership|UserManagement|login|auth|identity/iu.test(text)) return "project_people";
  if (/backup|recover|updat|restart|restore/iu.test(text)) return "persistence_upgrade";
  return "bug_base";
}
function requirements(group) {
  return (
    {
      "qingyu.sync": [16, 19, 20],
      "upload.incremental": [16, 18, 19],
      "build_upload.single": [16, 17, 18, 20],
      build: [16, 17, 18, 20],
      "relay.production": [16, 18, 19, 20],
      project_people: [1, 2, 3, 4, 5, 6, 7, 8, 10],
      persistence_upgrade: [21, 22, 23, 24],
    }[group] ?? [5, 6, 9, 13, 14, 15]
  );
}
function add({
  kind,
  key,
  title,
  source,
  applicable = surfaces,
  group,
  baselineIds,
  expected,
  steps,
  ...details
}) {
  const baseId = `${kind}-${hash(key).slice(0, 14)}`;
  const occurrence = idCounts.get(baseId) ?? 0;
  idCounts.set(baseId, occurrence + 1);
  const id = occurrence ? `${baseId}-${occurrence + 1}` : baseId;
  const prior = priorItems.get(id);
  const sourceHash = source ? (sourceHashes[source.file] ?? null) : null;
  const component = group ?? groupFor(`${title} ${source?.file ?? ""}`);
  const manual = prior?.manual ?? {};
  const results = Object.fromEntries(
    surfaces.map((surface) => [
      surface,
      {
        applicable: applicable.includes(surface),
        status: prior?.results?.[surface]?.status ?? "not_run",
        evidence: prior?.results?.[surface]?.evidence ?? [],
        actual: prior?.results?.[surface]?.actual ?? "",
        note: applicable.includes(surface)
          ? "Real execution and read-back required."
          : "This entry inventories a different surface; requirement-level coverage is tracked separately. Not an accepted scope exclusion.",
      },
    ]),
  );
  items.push({
    id,
    kind,
    title,
    group: component,
    baselineIds: baselineIds ?? requirements(component),
    source: source ?? null,
    sourceHash,
    ...details,
    prerequisites:
      "Dedicated preview instance; projects A/B; A-only, B-only and shared employee; unique GM. External components require independent test targets.",
    steps: steps ?? [
      "Prepare a fresh project-scoped test record and record its version.",
      "Invoke this actual runtime entry with its valid parameters; inspect the visible result.",
      "Read back persisted project, actor, state/version, events, attachments or final artifact as applicable.",
      "Repeat applicable error cases (wrong project/membership, stale version, repeat request, deleted record, disabled component).",
    ],
    expected:
      expected ??
      "Behavior and persisted result match the design and current business contract; no cross-project or production writes.",
    status: prior?.status ?? "not_run",
    results,
    manual,
    needsRevalidation: Boolean(
      prior?.needsRevalidation ||
      (prior?.sourceHash && sourceHash && prior.sourceHash !== sourceHash),
    ),
    generated: true,
  });
}

const baseline = [
  ["项目入口姓名登录", "首次登录只登记入口项目；原姓名仍解析为稳定原人员。"],
  ["单项目和多项目人员", "单项目直接进入；多项目只列出有效所属项目。"],
  ["唯一 GM", "GM 管理全部项目；普通姓名 gm 不获得 GM 身份。"],
  ["项目人员停用", "A 停用不影响 B；再次姓名登录不恢复显式停用关系。"],
  ["非所属项目读取", "列表、详情、附件、日志和统计均不泄露其他项目。"],
  ["写入归属", "编辑、评论、附件绑定和状态动作不能写到错误项目。"],
  ["项目快速切换", "A 迟到请求、草稿及人员选择不能覆盖 B。"],
  ["多窗口和多客户端", "同一人员并行打开不同项目；每个请求保持明确归属。"],
  ["关闭所有组件的基础全流程", "APK/EXE/Web 均可创建、处理、人工完成、验收并关闭 Bug。"],
  ["项目人员管理一致", "各端实际查看、关联、解除、停用和恢复当前项目人员。"],
  ["HTTP API 独立使用", "停止专用测试 EXE 后，HTTP 仍可登录、查询、评论和执行全部动作。"],
  ["服务端 MCP 独立使用", "不依赖 EXE；远端真实连接并完成主要 Bug 全部动作。"],
  ["HTTP/MCP 对等", "等价输入得到一致状态、版本、操作人、幂等结果和错误。"],
  ["并发和重复提交", "旧 expectedVersion 被拒；同幂等键不重复创建轮次或外部任务。"],
  ["附件三种读取", "HTTP 字节下载、服务 MCP 资源、EXE 本地落盘均正确归属且哈希一致。"],
  ["项目组件开关", "A 开启不影响 B；关闭后旧 HTTP/MCP/后台请求不能创建新任务。"],
  ["组件依赖和缺配置", "单次打包上传依赖清楚；缺连接显示待配置，不拖累 Bug 页面。"],
  ["运行中停用组件", "排队任务暂停、运行任务按规则收尾；历史产物保留；重启用不自动重放。"],
  ["上传和 Relay 项目归属", "列表、日志、取消、重试和回调只操作原项目任务。"],
  ["外部失败与人工处理", "打包、上传、Relay、同步失败不阻止本地人工完成与关闭。"],
  ["旧数据副本迁移", "一致性离线副本迁移前后 ID、Bug、人员、附件、历史和未完成任务可核对。"],
  ["APK 共存与升级", "新旧独立 applicationId 同设备共存；专用测试升级保留草稿和证据。"],
  ["EXE 共存与升级", "新旧真实 EXE 同开；专用升级重启保留配置、草稿、历史及更新隔离。"],
  ["回退演练", "按人工说明停止/恢复新版；保留回退前新增数据和任务证据；生产继续健康。"],
];
for (const [index, [title, expected]] of baseline.entries()) {
  const number = index + 1;
  const applicability =
    {
      7: ["apk", "exe", "web"],
      11: ["http"],
      12: ["server_mcp"],
      13: ["http", "server_mcp", "local_mcp"],
      22: ["apk"],
      23: ["exe"],
    }[number] ?? surfaces;
  add({
    kind: "baseline",
    key: `v2.1-${number}`,
    title: `${String(number).padStart(2, "0")} ${title}`,
    applicable: applicability,
    group: "design_baseline",
    baselineIds: [number],
    expected,
    design: "Design v2.1 section 13, expanded by sections 16 and 17.",
  });
}

function recordRoute(node, methodValues, pathValues, environment, registration = "direct", origin) {
  const source = location(origin ?? node);
  for (const method of methodValues)
    for (const url of pathValues) {
      if (!methods.has(method) || (!url.startsWith("/") && url !== "*")) continue;
      add({
        kind: "http_route",
        key: `${source.file}:${method}:${url}`,
        title: `${method} ${url}`,
        source,
        applicable: ["http"],
        method,
        path: url,
        registration,
        declarationSource: origin ? location(node) : null,
      });
    }
}
function routeObject(node, environment, origin) {
  if (!node.arguments[0] || !ts.isObjectLiteralExpression(node.arguments[0])) return;
  const object = node.arguments[0];
  if (
    !origin &&
    (!values(propValue(object, "method"), environment).length ||
      !values(propValue(object, "url") ?? propValue(object, "path"), environment).length)
  ) {
    add({
      kind: "http_registration_template",
      key: `${location(node).file}:${compact(node.getText(), 250)}`,
      title: `route helper template: method=${compact(propValue(object, "method")?.getText() ?? "unknown")} url=${compact((propValue(object, "url") ?? propValue(object, "path"))?.getText() ?? "unknown")}`,
      source: location(node),
      applicable: ["http"],
      requiresRuntimeExpansion: true,
      expected:
        "Compare the runtime registered route table to all statically expanded helper calls; record every dynamic variant and add missing concrete tests.",
    });
  }
  recordRoute(
    node,
    values(propValue(object, "method"), environment),
    values(propValue(object, "url") ?? propValue(object, "path"), environment),
    environment,
    origin ? "helper-expanded" : "route-object",
    origin,
  );
}
function visitFile(file) {
  const rel = relative(file.fileName);
  const api = rel.startsWith("apps/api/src/");
  const desktop = rel.startsWith("apps/desktop/src/");
  const web = rel.startsWith("apps/web/src/");
  const domain = rel.startsWith("packages/domain/src/");
  function visit(node) {
    if (api && rel.endsWith("/automation-routes.ts") && ts.isArrayLiteralExpression(node)) {
      const name = values(node.elements[0])[0];
      if (name?.startsWith("qa_"))
        add({
          kind: "mcp_tool",
          key: `${rel}:${name}`,
          title: name,
          source: location(node),
          applicable: serverToolSurfaces,
          toolName: name,
          description: values(node.elements[1])[0] ?? "",
          method: values(node.elements[2])[0],
          path: values(node.elements[3])[0],
          registration: "fixed-http-adapter",
        });
    }
    if (api && ts.isCallExpression(node)) {
      const environment = loopEnvironment(node);
      if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text.toUpperCase();
        const receiver = node.expression.expression.getText();
        if (/^(?:app|server|fastify|router|instance)$/u.test(receiver)) {
          if (methods.has(method))
            recordRoute(node, [method], values(node.arguments[0], environment), environment);
          else if (method === "ROUTE") routeObject(node, environment);
        }
      } else if (
        ts.isIdentifier(node.expression) &&
        /^(?:route|endpoint)$/iu.test(node.expression.text)
      ) {
        const declaration = initOf(node.expression);
        const fn = unwrap(declaration?.initializer) ?? declaration;
        if (
          fn &&
          (ts.isArrowFunction(fn) || ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn))
        ) {
          const bindings = new Map(environment);
          fn.parameters.forEach((param, index) =>
            bindings.set(param.name.getText(), values(node.arguments[index], environment)),
          );
          function expand(child) {
            if (
              ts.isCallExpression(child) &&
              ts.isPropertyAccessExpression(child.expression) &&
              child.expression.name.text === "route"
            )
              routeObject(child, loopEnvironment(child, bindings), node);
            ts.forEachChild(child, expand);
          }
          if (fn.body) expand(fn.body);
        }
      }
    }
    if (desktop && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression.getText();
      const operation = node.expression.name.text;
      if (receiver === "ipcMain" && /^(?:handle|on)$/u.test(operation)) {
        const channel =
          values(node.arguments[0])[0] ??
          compact(node.arguments[0]?.getText() ?? "dynamic channel");
        add({
          kind: "desktop_ipc_action",
          key: `${rel}:${channel}`,
          title: `${operation} ${channel}`,
          source: location(node),
          applicable: ["exe"],
          channel,
        });
      } else if (
        /^(?:app|mainWindow|notification|tray|updater|transport|mcpServer)$/u.test(receiver) &&
        /^(?:on|once)$/u.test(operation)
      ) {
        const event =
          values(node.arguments[0])[0] ?? compact(node.arguments[0]?.getText() ?? "dynamic event");
        add({
          kind: "desktop_event",
          key: `${rel}:${receiver}:${event}`,
          title: `${receiver}.${event}`,
          source: location(node),
          applicable: ["exe"],
          expected:
            "Exercise this real notification/window/protocol/lifecycle event in the isolated installed client; verify project, target client identity and preserved user data.",
        });
      }
    }
    if (
      desktop &&
      ts.isObjectLiteralExpression(node) &&
      property(node, "click") &&
      (property(node, "label") || property(node, "role"))
    ) {
      const label =
        values(propValue(node, "label"))[0] ??
        values(propValue(node, "role"))[0] ??
        "dynamic menu item";
      add({
        kind: "desktop_menu_action",
        key: `${rel}:${label}`,
        title: label,
        source: location(node),
        applicable: ["exe"],
      });
    }
    if ((api || desktop) && /mcp|automation\.ts$/iu.test(rel)) {
      if (ts.isObjectLiteralExpression(node)) {
        const name = values(propValue(node, "name"))[0];
        if (name?.startsWith("qa_"))
          add({
            kind: "mcp_tool",
            key: `${rel}:${name}`,
            title: name,
            source: location(node),
            applicable: api ? serverToolSurfaces : ["local_mcp"],
            toolName: name,
            description: values(propValue(node, "description"))[0] ?? "",
          });
      }
      if (
        ts.isCallExpression(node) &&
        /^(?:tool|registerTool|definition)$/u.test(node.expression.getText())
      ) {
        const name = values(node.arguments[0])[0];
        if (name?.startsWith("qa_"))
          add({
            kind: "mcp_tool",
            key: `${rel}:${name}`,
            title: name,
            source: location(node),
            applicable: api ? serverToolSurfaces : ["local_mcp"],
            toolName: name,
            description:
              values(node.arguments[node.expression.getText() === "definition" ? 1 : 2])[0] ?? "",
          });
      }
    }
    if (web && ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/u.test(node.name.text)) {
      add({
        kind: "web_page_component",
        key: `${rel}:${node.name.text}`,
        title: node.name.text,
        source: location(node),
        applicable: ["web", "exe"],
      });
    }
    if (
      web &&
      ts.isVariableDeclaration(node) &&
      /^[A-Z]/u.test(node.name.getText()) &&
      node.initializer &&
      ts.isArrowFunction(node.initializer)
    ) {
      add({
        kind: "web_page_component",
        key: `${rel}:${node.name.getText()}`,
        title: node.name.getText(),
        source: location(node),
        applicable: ["web", "exe"],
      });
    }
    if (web && (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))) {
      const tag = node.tagName.getText();
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
      const handlers = attrs.filter((attr) =>
        /^on(?:Click|Change|Submit|KeyDown|Blur|Focus|Drop|DoubleClick|Pointer)/u.test(
          attr.name.getText(),
        ),
      );
      if (handlers.length || /^(?:button|input|select|textarea|form|summary|a)$/u.test(tag)) {
        const named = attrs
          .filter((attr) =>
            /^(?:aria-label|title|name|type|role|data-testid|placeholder)$/u.test(
              attr.name.getText(),
            ),
          )
          .map((attr) => compact(attr.getText(), 120));
        const handlerText = handlers.map((attr) => compact(attr.getText(), 160));
        let label = "";
        if (ts.isJsxElement(node.parent))
          label = compact(
            node.parent.children
              .filter(ts.isJsxText)
              .map((child) => child.text)
              .join(" "),
            100,
          );
        const title = compact(
          [tag, label, ...named, ...handlerText].filter(Boolean).join(" | "),
          240,
        );
        add({
          kind: "web_control",
          key: `${rel}:${title}`,
          title,
          source: location(node),
          applicable: ["web", "exe"],
          tag,
          handlerNames: handlers.map((attr) => attr.name.getText()),
        });
      }
    }
    if (
      (api || desktop || rel.startsWith("apps/worker/src/")) &&
      ts.isCallExpression(node) &&
      /(?:^|\.)(?:setInterval|setTimeout|setImmediate)$/u.test(node.expression.getText())
    ) {
      add({
        kind: "background_timer",
        key: `${rel}:${compact(node.getText(), 300)}`,
        title: compact(node.getText(), 180),
        source: location(node),
        applicable: desktop ? ["exe", "local_mcp"] : ["http", "server_mcp"],
        expected:
          "Exercise the timer's actual refresh/retry/dispatch/timeout/recovery behavior using only isolated state, then read back result and check old production health.",
      });
    }
    if (
      (api || desktop || rel.startsWith("apps/worker/src/")) &&
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      /^(?:start.*(?:Pump|Runner|Server)|(?:claim|dispatch|recover|resume|restore|backup|retry|cancel|stop|tick|runOnce|poll)$)/iu.test(
        node.name.getText(),
      )
    ) {
      add({
        kind: "background_operation",
        key: `${rel}:${node.name.getText()}`,
        title: node.name.getText(),
        source: location(node),
        applicable: desktop ? ["exe", "local_mcp"] : ["http", "server_mcp"],
      });
    }
    if (domain && ts.isInterfaceDeclaration(node) && /Command(?:Base)?$/u.test(node.name.text)) {
      const type = node.members.find((member) => member.name?.getText() === "type");
      if (type?.type && ts.isLiteralTypeNode(type.type) && ts.isStringLiteral(type.type.literal))
        add({
          kind: "state_action",
          key: `${rel}:${type.type.literal.text}:${node.name.text}`,
          title: `${type.type.literal.text} (${node.name.text})`,
          source: location(node),
          applicable: surfaces,
          action: type.type.literal.text,
          expected:
            "Execute every supported lawful state transition plus rejected guards for this action; read back aggregate version, repair/verification records, events and outbox without arbitrary status assignment.",
        });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
}
for (const file of sourceFiles) visitFile(file);

for (const file of files.filter((file) => file.endsWith(".kt"))) {
  const rel = relative(file);
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/u);
  let composableNext = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*@Composable\s*$/u.test(line)) composableNext = true;
    const functionMatch = line.match(/\bfun\s+([\w.]+)\s*\(/u);
    if (functionMatch && (composableNext || /(?:Screen|Page)$/u.test(functionMatch[1]))) {
      add({
        kind: "android_page_component",
        key: `${rel}:${functionMatch[1]}`,
        title: functionMatch[1],
        source: { file: rel, line: index + 1 },
        applicable: ["apk"],
      });
      composableNext = false;
    }
    if (
      /\bon(?:Click|ValueChange|CheckedChange|DismissRequest|Select|Confirm)\s*=|\.clickable\s*\(/u.test(
        line,
      )
    ) {
      const title = compact(lines.slice(index, index + 3).join(" "), 240);
      add({
        kind: "android_control",
        key: `${rel}:${title}`,
        title,
        source: { file: rel, line: index + 1 },
        applicable: ["apk"],
      });
    }
    if (
      /\b(?:enqueueUniqueWork|enqueueUniquePeriodicWork|registerForActivityResult|setForeground|startForeground|notify)\s*\(/u.test(
        line,
      )
    ) {
      add({
        kind: "android_background_operation",
        key: `${rel}:${compact(line)}`,
        title: compact(line),
        source: { file: rel, line: index + 1 },
        applicable: ["apk"],
      });
    }
  }
}

const requiredTools = [
  "qa_list_projects",
  "qa_list_bugs",
  "qa_get_bug_context",
  "qa_create_bug",
  "qa_update_bug",
  "qa_begin_fix",
  "qa_submit_fix",
  "qa_bug_action",
  "qa_add_comment",
  "qa_upload_attachment",
  "qa_bind_attachment",
  "qa_materialize_attachment",
  "qa_delete_bug",
  "qa_list_users",
  "qa_manage_user",
  "qa_list_modules",
  "qa_get_metrics",
];
for (const name of requiredTools) {
  add({
    kind: "required_mcp_parity",
    key: `required:${name}`,
    title: name,
    applicable: ["server_mcp", "local_mcp"],
    group: "bug_base",
    baselineIds: [11, 12, 13, 14, 15],
    proposedName: true,
    expected:
      "Expose this business capability under the documented final tool name in both MCP entrances and verify HTTP-equivalent results; service materialization returns remote resources rather than unusable server file paths.",
  });
}
for (const surface of ["apk", "exe"])
  for (const component of [
    "build",
    "build_upload.single",
    "upload.incremental",
    "relay.production",
    "qingyu.sync",
  ]) {
    add({
      kind: "external_full_chain",
      key: `${surface}:${component}`,
      title: `${surface.toUpperCase()} ${component} final result`,
      applicable: [surface],
      group: component,
      baselineIds: [16, 17, 18, 19, 20],
      expected:
        "Trigger from the installed client against a dedicated test target, wait for terminal result, verify external task/order ID, final artifact/hash/download or callback and durable state. A queued receipt, mock, assume-success or command exit alone is insufficient.",
    });
  }
const bugStatesFile = sourceFiles.find(
  (file) => relative(file.fileName) === "packages/domain/src/statuses.ts",
);
let bugStates = [];
if (bugStatesFile) {
  const findStates = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === "BUG_STATES")
      bugStates = values(node.initializer);
    ts.forEachChild(node, findStates);
  };
  findStates(bugStatesFile);
}
for (const from of bugStates)
  for (const to of bugStates) {
    add({
      kind: "state_transition_pair",
      key: `bug:${from}:${to}`,
      title: `${from} → ${to}`,
      applicable: surfaces,
      group: "bug_base",
      baselineIds: [9, 13, 14, 20],
      requiresContractReview: true,
      expected:
        "Prepare the source state with formal business actions. Check all actions that can produce the target state and their documented guards; an unsupported direct transition must return the documented error with unchanged version/events. Record lawful/forbidden and evidence, never infer a pass from this inventory.",
    });
  }
const observedIds = new Set(items.map((item) => item.id));
const retiredItems = [
  ...(previous.retiredItems ?? []),
  ...(previous.items ?? [])
    .filter((item) => !observedIds.has(item.id))
    .map((item) => ({
      ...item,
      retiredFromStaticInventoryAt: new Date().toISOString(),
      reviewRequired: true,
    })),
];
const byKind = Object.fromEntries(
  [...new Set(items.map((item) => item.kind))]
    .sort()
    .map((kind) => [kind, items.filter((item) => item.kind === kind).length]),
);
let head = null;
try {
  head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
} catch {
  /* Keep usable inventory without claiming a commit. */
}
const data = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  evidenceMapping: previous.evidenceMapping ?? null,
  sourceHead: head,
  sourceRoots,
  designVersion: "2.1",
  sourceHashes,
  surfaces: Object.fromEntries(surfaces.map((surface, index) => [surface, surfaceLabels[index]])),
  statusVocabulary: ["not_run", "passed", "failed", "blocked", "not_applicable"],
  completionRule:
    "A required failed/not_run/blocked item prevents completion. not_applicable requires an explicit reviewed reason; tool/route absence is a gap, not a scope exemption.",
  preservation:
    "Edit item.results[surface] with status, actual, evidence and item.manual as needed. Regeneration preserves matching IDs and retains removed items under retiredItems. Changed sourceHash flags needsRevalidation; it never silently validates or deletes evidence.",
  inventoryLimitations: [
    "Static discovery is a starting inventory, not proof of registered runtime routes or UI functionality.",
    sharedDesktopCatalog
      ? "Desktop main enables sharedApi and its definition getter uses the server catalog. Server tool rows therefore also require local MCP acceptance; explicit legacy desktop tool rows remain as compatibility inventory. Verify live local tools/list and each invocation separately."
      : "Desktop shared server catalog was not statically confirmed; compare the actual local tools/list to source tools before acceptance.",
    "Fastify direct routes, statically resolvable imports/templates/for-of loops and route helpers are expanded without running application code.",
    "Unresolvable computed registration, runtime component variations and visual-only affordances require a runtime inventory comparison before acceptance.",
    "Web component rows include reusable capitalized functions; Android controls are source-based Compose callback sites. Collapse duplicates only with a recorded reason and retained evidence.",
    "State-pair rows require contract review; every actual action/guard remains a required real test, and internal states must not be set with arbitrary database writes.",
    "Per-surface applicability describes that entry's origin and is not a design scope exemption. Baselines and required parity rows track cross-surface obligations.",
    "Working code may change concurrently; rerun after implementation stabilizes and compare source hashes.",
  ],
  resourceGaps: [
    {
      id: "external-build",
      affects: ["build", "build_upload.single"],
      status: "unverified",
      required:
        "Dedicated Jenkins test Job/workspace, licensed free executor, independent artifacts and upload target; do not borrow an active production Worker.",
    },
    {
      id: "external-upload",
      affects: ["upload.incremental", "build_upload.single"],
      status: "unverified",
      required:
        "Dedicated test account/product/channel/prefix, final target/download verification and failure/retry/cancel scenarios.",
    },
    {
      id: "external-relay",
      affects: ["relay.production"],
      status: "unverified",
      required:
        "Dedicated Relay project/workspace/test task, callback mapping and available independent executor.",
    },
    {
      id: "external-qingyu",
      affects: ["qingyu.sync"],
      status: "unverified",
      required:
        "Dedicated third-party test identity/project/order; no genuine work order mutation.",
    },
    {
      id: "physical-android",
      affects: ["apk"],
      status: "unverified",
      required:
        "Physical device for appropriate capture/file/upgrade acceptance plus separate preview applicationId and test upgrade environment.",
    },
    {
      id: "historical-copy",
      affects: ["migration", "rollback"],
      status: "unverified",
      required:
        "Pinned, fully validated consistent SQLite+attachment recovery set restored only into isolated data roots; imported queues/outbox paused.",
    },
  ],
  summary: {
    itemCount: items.length,
    byKind,
    baselineCount: baseline.length,
    fileCount: files.length,
    resultsBySurface: Object.fromEntries(
      surfaces.map((surface) => [surface, Object.fromEntries(dataStatuses(items, surface))]),
    ),
  },
  items,
  retiredItems,
};
function dataStatuses(records, surface) {
  const counts = new Map();
  for (const item of records)
    if (item.results[surface].applicable)
      counts.set(item.results[surface].status, (counts.get(item.results[surface].status) ?? 0) + 1);
  return counts;
}
const escape = (value) =>
  String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
const lines = [
  "# QA Hub 项目制与组件化真实验收矩阵",
  "",
  `生成时点：${data.generatedAt}；设计 v2.1；源码 HEAD：\`${head}\`。`,
  "",
  "本文件是代码和需求的验收清单，初始全部为 `not_run`。代码存在、静态推导、mock、编译成功、端口监听或排队成功均不算通过。逐入口真实操作并读回项目、操作人、状态、版本、事件、附件及最终产物后，才登记结果。",
  "",
  "机器记录保存在 `coverage-matrix.json`。每条包含前提、步骤、预期、适用入口、各入口状态/实际结果/证据和人工备注。直接编辑 JSON 中 `results` 与 `manual`；重新运行 `node scripts/project-components/generate-coverage-matrix.mjs` 会保留结果，源码变化会标记复验，消失条目转入 `retiredItems` 保留证据。",
  "",
  "## 24 项最低基线",
  "",
  "A = 此基线须通过该入口真实验收；— = 该条描述其他入口，不能据此排除本版本要求。所有状态均独立记录。",
  "",
  `| 编号及场景 | ${surfaceLabels.join(" | ")} | 预期 |`,
  `| --- | ${surfaces.map(() => "---").join(" | ")} | --- |`,
];
for (const item of items.filter((item) => item.kind === "baseline"))
  lines.push(
    `| ${escape(item.title)} | ${surfaces.map((surface) => (item.results[surface].applicable ? `A · ${item.results[surface].status}` : "—")).join(" | ")} | ${escape(item.expected)} |`,
  );
lines.push("", "## 盘点规模", "", "| 类别 | 条目数 |", "| --- | --- |");
for (const [kind, count] of Object.entries(byKind)) lines.push(`| ${kind} | ${count} |`);
lines.push("", "## 待确认的独立资源", "");
for (const gap of data.resourceGaps) lines.push(`- **${gap.id}** (${gap.status}): ${gap.required}`);
lines.push("", "## 静态盘点边界与运行补全", "");
for (const limitation of data.inventoryLimitations) lines.push(`- ${limitation}`);
lines.push(
  "",
  "完成验收前应与实际运行时 HTTP 路由表、服务端/本地 MCP tools/list、Web/EXE/Android 的页面与可点击控件逐项比对，补充动态入口。状态机必须核对每种动作的合法转换和失败输入；跨项目、无成员资格、旧版本、重复幂等键、删除、组件停用不能遗漏。有必测失败或未执行时不得将 Goal 标记 complete。",
  "",
);
for (const kind of Object.keys(byKind).filter((kind) => kind !== "baseline")) {
  lines.push(
    `## ${kind}`,
    "",
    "| 测试 ID | 功能/入口 | 适用客户端 | 来源 | 状态 |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const item of items.filter((entry) => entry.kind === kind))
    lines.push(
      `| ${item.id} | ${escape(item.title)} | ${surfaces.filter((surface) => item.results[surface].applicable).join(", ")} | ${item.source ? `${item.source.file}:${item.source.line}` : "design v2.1"} | ${item.status}${item.needsRevalidation ? " · revalidation required" : ""} |`,
    );
  lines.push("");
}
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2) + "\n");
fs.writeFileSync(markdownPath, lines.join("\n"));
process.stdout.write(
  JSON.stringify(
    {
      generated: [relative(jsonPath), relative(markdownPath)],
      summary: data.summary,
      retiredItemCount: retiredItems.length,
    },
    null,
    2,
  ) + "\n",
);
