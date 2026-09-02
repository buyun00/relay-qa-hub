import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { QA_HUB_MCP_TOOLS, QaHubMcpError, type QaHubMcpTools } from "./mcp-api.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const LATEST_PROTOCOL_VERSION = "2025-06-18";

export const QA_HUB_MCP_INSTRUCTIONS =
  "QA Hub 是 Bug 生命周期唯一事实源。先调用 qa_list_projects、qa_list_bugs 和 qa_get_bug_context；需要修复时调用 qa_begin_fix，然后在编辑器内做窄改动、运行真实验证、提交 Git，再用 qa_submit_fix 回写实际命令与提交 SHA。qa_submit_fix 记录代码交付，任务对用户显示为已完成待验收，精确构建匹配仍作为内部验收证据；进入已完成待验收后项目内任意已登录成员都能在详情中直接关闭，也能从详情删除单子，不再检查提报人、负责人或关闭人身份。不要报告未执行的测试，不要抢占他人单子。附件先用 qa_materialize_attachment 下载并校验。";

type JsonRpcId = string | number;

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface QaHubMcpServerStatus {
  readonly state: "stopped" | "starting" | "listening" | "failed";
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly url: string;
  readonly lastError: string | null;
}

export interface QaHubMcpServerOptions {
  readonly port: number;
  readonly tools: Pick<QaHubMcpTools, "definitions" | "call">;
  readonly serverVersion: string;
  readonly onStatus?: (status: QaHubMcpServerStatus) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRpcError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): unknown {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function jsonRpcResult(id: JsonRpcId, result: unknown): unknown {
  return { jsonrpc: "2.0", id, result };
}

function responseHeaders(response: ServerResponse): void {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  responseHeaders(response);
  response.statusCode = status;
  response.setHeader("Content-Length", Buffer.byteLength(body, "utf8"));
  response.end(body);
}

function hostAllowed(value: string | undefined): boolean {
  if (value === undefined) return false;
  const host = value.trim().toLowerCase();
  return (
    /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/u.test(host) || /^\[::1\](?::\d{1,5})?$/u.test(host)
  );
}

function originAllowed(value: string | undefined): boolean {
  if (value === undefined) return true;
  try {
    const origin = new URL(value);
    return (
      origin.protocol === "http:" &&
      (origin.hostname === "127.0.0.1" ||
        origin.hostname === "localhost" ||
        origin.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function remoteAllowed(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

async function readRequestBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new QaHubMcpError("MCP_REQUEST_TOO_LARGE", "MCP request exceeded 1 MiB", 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function parseRequest(value: unknown): JsonRpcRequest {
  if (!isRecord(value) || value["jsonrpc"] !== "2.0" || typeof value["method"] !== "string") {
    throw new QaHubMcpError("MCP_INVALID_REQUEST", "Invalid JSON-RPC 2.0 request", 400);
  }
  const id = value["id"];
  if (id !== undefined && typeof id !== "string" && typeof id !== "number") {
    throw new QaHubMcpError("MCP_INVALID_REQUEST", "JSON-RPC id must be a string or number", 400);
  }
  return {
    jsonrpc: "2.0",
    ...(id === undefined ? {} : { id }),
    method: value["method"],
    ...(value["params"] === undefined ? {} : { params: value["params"] }),
  };
}

function toolError(error: unknown): unknown {
  const code = error instanceof QaHubMcpError ? error.code : "QA_HUB_MCP_TOOL_FAILED";
  const message = error instanceof Error ? error.message : "QA Hub MCP tool failed";
  const status = error instanceof QaHubMcpError ? error.status : null;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, code, message, status }, null, 2),
      },
    ],
    isError: true,
  };
}

function toolSuccess(value: unknown): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isRecord(value) ? { structuredContent: value } : {}),
    isError: false,
  };
}

export class QaHubMcpHttpServer {
  private server: Server | null = null;
  private currentStatus: QaHubMcpServerStatus;

  constructor(private readonly options: QaHubMcpServerOptions) {
    this.currentStatus = this.statusValue("stopped", options.port, null);
  }

  get status(): QaHubMcpServerStatus {
    return this.currentStatus;
  }

  private statusValue(
    state: QaHubMcpServerStatus["state"],
    port: number,
    lastError: string | null,
  ): QaHubMcpServerStatus {
    return Object.freeze({
      state,
      host: "127.0.0.1",
      port,
      url: `http://127.0.0.1:${port}/mcp`,
      lastError,
    });
  }

  private setStatus(
    state: QaHubMcpServerStatus["state"],
    port: number,
    lastError: string | null,
  ): void {
    this.currentStatus = this.statusValue(state, port, lastError);
    this.options.onStatus?.(this.currentStatus);
  }

  private async dispatch(request: JsonRpcRequest): Promise<unknown | null> {
    if (request.id === undefined) {
      // JSON-RPC notifications intentionally have no response body.
      return null;
    }
    switch (request.method) {
      case "initialize": {
        if (!isRecord(request.params)) {
          return jsonRpcError(request.id, -32602, "initialize params must be an object");
        }
        const requestedVersion = request.params["protocolVersion"];
        if (typeof requestedVersion !== "string") {
          return jsonRpcError(request.id, -32602, "protocolVersion is required");
        }
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
          ? requestedVersion
          : LATEST_PROTOCOL_VERSION;
        return jsonRpcResult(request.id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "relay-qa-hub-desktop", version: this.options.serverVersion },
          instructions: QA_HUB_MCP_INSTRUCTIONS,
        });
      }
      case "ping":
        return jsonRpcResult(request.id, {});
      case "tools/list":
        return jsonRpcResult(request.id, { tools: this.options.tools.definitions });
      case "tools/call": {
        if (!isRecord(request.params) || typeof request.params["name"] !== "string") {
          return jsonRpcError(request.id, -32602, "tools/call requires a tool name");
        }
        const argumentsValue = request.params["arguments"] ?? {};
        try {
          const value = await this.options.tools.call(request.params["name"], argumentsValue);
          return jsonRpcResult(request.id, toolSuccess(value));
        } catch (error) {
          return jsonRpcResult(request.id, toolError(error));
        }
      }
      default:
        return jsonRpcError(request.id, -32601, `Method not found: ${request.method}`);
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!remoteAllowed(request.socket.remoteAddress)) {
      sendJson(response, 403, { code: "MCP_REMOTE_NOT_ALLOWED" });
      return;
    }
    if (!hostAllowed(request.headers.host) || !originAllowed(request.headers.origin)) {
      sendJson(response, 403, { code: "MCP_ORIGIN_NOT_ALLOWED" });
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      sendJson(response, 400, { code: "MCP_URL_INVALID" });
      return;
    }
    if (pathname === "/health" && request.method === "GET") {
      sendJson(response, 200, {
        status: "ready",
        service: "relay-qa-hub-desktop-mcp",
        endpoint: "/mcp",
        transport: "streamable-http",
      });
      return;
    }
    if (pathname !== "/mcp") {
      sendJson(response, 404, { code: "MCP_PATH_NOT_FOUND" });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      sendJson(response, 405, { code: "MCP_METHOD_NOT_ALLOWED" });
      return;
    }
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      sendJson(response, 415, { code: "MCP_CONTENT_TYPE_REQUIRED" });
      return;
    }
    let parsed: unknown;
    try {
      const bytes = await readRequestBody(request);
      parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    } catch (error) {
      if (error instanceof QaHubMcpError && error.status === 413) {
        sendJson(response, 413, jsonRpcError(null, -32600, error.message));
        return;
      }
      sendJson(response, 400, jsonRpcError(null, -32700, "Parse error"));
      return;
    }
    let rpcRequest: JsonRpcRequest;
    try {
      rpcRequest = parseRequest(parsed);
    } catch (error) {
      sendJson(
        response,
        400,
        jsonRpcError(null, -32600, error instanceof Error ? error.message : "Invalid request"),
      );
      return;
    }
    const result = await this.dispatch(rpcRequest);
    if (result === null) {
      response.statusCode = 202;
      response.setHeader("Cache-Control", "no-store");
      response.end();
      return;
    }
    sendJson(response, 200, result);
  }

  async start(): Promise<void> {
    if (this.server !== null) return;
    this.setStatus("starting", this.options.port, null);
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) sendJson(response, 500, { code: "MCP_INTERNAL_ERROR" });
        else response.destroy();
      });
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.options.port, "127.0.0.1");
      });
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : this.options.port;
      this.setStatus("listening", port, null);
    } catch (error) {
      this.server = null;
      const code = (error as NodeJS.ErrnoException).code ?? "MCP_LISTEN_FAILED";
      this.setStatus("failed", this.options.port, code);
      server.close();
      throw new QaHubMcpError(code, "QA Hub EXE could not start its loopback MCP server");
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server !== null) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.setStatus("stopped", this.currentStatus.port, null);
  }
}

export { QA_HUB_MCP_TOOLS };
