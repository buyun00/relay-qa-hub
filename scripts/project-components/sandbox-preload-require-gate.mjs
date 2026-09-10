import { createHash } from "node:crypto";

import ts from "typescript";

export const SANDBOX_PRELOAD_REQUIRE_ALLOWLIST = Object.freeze([
  "electron",
  "events",
  "timers",
  "url",
]);

function gateError(code, label, detail) {
  const error = new Error(`${code}:${label}:${detail}`);
  error.code = code;
  return error;
}

function asBytes(input, label) {
  if (typeof input === "string") return Buffer.from(input, "utf8");
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) return Buffer.from(input);
  throw gateError("PREVIEW_SANDBOX_PRELOAD_SOURCE_INVALID", label, "not-bytes");
}

function nodeLocation(sourceFile, node) {
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false));
  return `${location.line + 1}:${location.character + 1}`;
}

function isDirectRequireIdentifier(node) {
  return (
    ts.isIdentifier(node) &&
    node.text === "require" &&
    ts.isCallExpression(node.parent) &&
    node.parent.expression === node &&
    !node.parent.questionDotToken
  );
}

function isRequireStringProperty(node) {
  if (!ts.isStringLiteralLike(node) || node.text !== "require") return false;
  const parent = node.parent;
  return (
    (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) ||
    ("name" in parent && parent.name === node)
  );
}

export function inspectSandboxPreload(input, label = "preload.cjs") {
  const bytes = asBytes(input, label);
  if (bytes.length === 0) {
    throw gateError("PREVIEW_SANDBOX_PRELOAD_SOURCE_INVALID", label, "empty");
  }
  const source = bytes.toString("utf8");
  const sourceFile = ts.createSourceFile(
    label,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const parseDiagnostics = sourceFile.parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    const diagnostic = parseDiagnostics[0];
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ").slice(0, 160);
    throw gateError(
      "PREVIEW_SANDBOX_PRELOAD_SYNTAX_INVALID",
      label,
      `${diagnostic.start ?? 0}:${message}`,
    );
  }

  const modules = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "require") {
        if (node.questionDotToken) {
          throw gateError(
            "PREVIEW_SANDBOX_PRELOAD_REQUIRE_SHAPE_INVALID",
            label,
            `optional:${nodeLocation(sourceFile, node)}`,
          );
        }
        if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) {
          throw gateError(
            "PREVIEW_SANDBOX_PRELOAD_REQUIRE_NON_LITERAL",
            label,
            nodeLocation(sourceFile, node),
          );
        }
        const specifier = node.arguments[0].text;
        if (!SANDBOX_PRELOAD_REQUIRE_ALLOWLIST.includes(specifier)) {
          throw gateError(
            "PREVIEW_SANDBOX_PRELOAD_REQUIRE_FORBIDDEN",
            label,
            `${nodeLocation(sourceFile, node)}:${specifier}`,
          );
        }
        modules.push(specifier);
      }
    }
    if (ts.isIdentifier(node) && node.text === "require" && !isDirectRequireIdentifier(node)) {
      throw gateError(
        "PREVIEW_SANDBOX_PRELOAD_REQUIRE_SHAPE_INVALID",
        label,
        nodeLocation(sourceFile, node),
      );
    }
    if (isRequireStringProperty(node)) {
      throw gateError(
        "PREVIEW_SANDBOX_PRELOAD_REQUIRE_SHAPE_INVALID",
        label,
        nodeLocation(sourceFile, node),
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (!modules.includes("electron")) {
    throw gateError("PREVIEW_SANDBOX_PRELOAD_ELECTRON_REQUIRE_MISSING", label, "electron");
  }
  return Object.freeze({
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    modules: Object.freeze(modules),
  });
}

export function assertSandboxPreloadBinding(candidateInput, sourceInput, sourceSnapshot, label) {
  const candidateBytes = asBytes(candidateInput, label);
  const sourceBytes = asBytes(sourceInput, `${label}:source`);
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  if (sourceSnapshot?.bytes !== sourceBytes.length || sourceSnapshot?.sha256 !== sourceSha256) {
    throw gateError("PREVIEW_SANDBOX_PRELOAD_SOURCE_SNAPSHOT_INVALID", label, sourceSha256);
  }
  const candidateSnapshot = inspectSandboxPreload(candidateBytes, label);
  if (
    !candidateBytes.equals(sourceBytes) ||
    candidateSnapshot.bytes !== sourceSnapshot.bytes ||
    candidateSnapshot.sha256 !== sourceSnapshot.sha256
  ) {
    throw gateError("PREVIEW_SANDBOX_PRELOAD_BINDING_MISMATCH", label, candidateSnapshot.sha256);
  }
  return candidateSnapshot;
}
