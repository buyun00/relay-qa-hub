import { createHash } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";

import type { MobileNotificationRecord } from "@relay-qa-hub/storage";

import type { MobileNotificationStore } from "./mobile-inbox.js";

export const MOBILE_NOTIFICATION_HINT_PATH = "/api/v1/notifications/stream" as const;
export const MOBILE_NOTIFICATION_HINT_PROTOCOL = "qa-hub.notifications.v1" as const;

const WEBSOCKET_VERSION = "13";
const WEBSOCKET_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME_PAYLOAD_BYTES = 64 * 1024;
const POLL_INTERVAL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;
const MAX_SENT_NOTIFICATION_IDS = 256;

interface HintConnection {
  socket: Socket;
  actorId: string;
  sentNotificationIds: Set<string>;
  onData: (chunk: Buffer) => void;
  onError: () => void;
  onClose: () => void;
  lastPongAt: number;
  frameBuffer: Buffer;
  closed: boolean;
}

export interface MobileNotificationHintChannelOptions {
  readonly server: HttpServer;
  readonly store: MobileNotificationStore;
  readonly actorId: string;
  readonly bearerToken: string;
  readonly resolveBrowserSession?: (cookieHeader: string) => Promise<string | null>;
  readonly now?: () => Date;
  readonly logger?: {
    readonly warn?: (object: unknown, message?: string) => void;
  };
}

export interface MobileNotificationHintChannel {
  readonly close: () => Promise<void>;
}

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function headerTokens(value: string | readonly string[] | undefined): readonly string[] {
  const joined =
    typeof value === "string" ? value : value === undefined ? "" : [...value].join(",");
  return joined
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function hasUpgradeToken(value: string | readonly string[] | undefined): boolean {
  return headerTokens(value).some((token) => token.toLowerCase() === "upgrade");
}

function isUpgradeRequest(request: IncomingMessage): boolean {
  return (
    request.method === "GET" &&
    headerValue(request.headers.upgrade)?.toLowerCase() === "websocket" &&
    hasUpgradeToken(request.headers.connection) &&
    headerValue(request.headers["sec-websocket-version"]) === WEBSOCKET_VERSION
  );
}

function websocketAccept(key: string): string {
  return createHash("sha1")
    .update(key + WEBSOCKET_MAGIC, "ascii")
    .digest("base64");
}

function sendHttpError(socket: Socket, status: number, phrase: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${phrase}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function makeFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (payload.length > MAX_FRAME_PAYLOAD_BYTES) {
    throw new Error("websocket frame payload is too large");
  }
  const length = payload.length;
  if (length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
  }
  const frame = Buffer.alloc(4 + length);
  frame[0] = 0x80 | opcode;
  frame[1] = 126;
  frame.writeUInt16BE(length, 2);
  payload.copy(frame, 4);
  return frame;
}

function sendFrame(connection: HintConnection, opcode: number, payload?: Buffer): void {
  if (connection.closed || connection.socket.destroyed) return;
  connection.socket.write(makeFrame(opcode, payload));
}

function closeConnection(connection: HintConnection, code = 1000): void {
  if (connection.closed) return;
  connection.closed = true;
  if (!connection.socket.destroyed) {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    connection.socket.write(makeFrame(0x8, payload));
    connection.socket.end();
  }
  connection.socket.removeListener("data", connection.onData);
}

function parseFrames(connection: HintConnection, onPong: () => void): void {
  while (connection.frameBuffer.length >= 2 && !connection.closed) {
    const first = connection.frameBuffer[0] ?? 0;
    const second = connection.frameBuffer[1] ?? 0;
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let offset = 2;
    let payloadLength = second & 0x7f;
    if (payloadLength === 126) {
      if (connection.frameBuffer.length < 4) return;
      payloadLength = connection.frameBuffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLength === 127) {
      if (connection.frameBuffer.length < 10) return;
      const length = connection.frameBuffer.readBigUInt64BE(2);
      if (length > BigInt(MAX_FRAME_PAYLOAD_BYTES)) {
        closeConnection(connection, 1009);
        return;
      }
      payloadLength = Number(length);
      offset = 10;
    }
    if (payloadLength > MAX_FRAME_PAYLOAD_BYTES) {
      closeConnection(connection, 1009);
      return;
    }
    if (!masked || !fin || (opcode >= 0x8 && payloadLength > 125)) {
      closeConnection(connection, 1002);
      return;
    }
    const frameLength = offset + 4 + payloadLength;
    if (connection.frameBuffer.length < frameLength) return;
    const mask = connection.frameBuffer.subarray(offset, offset + 4);
    const payload = Buffer.from(connection.frameBuffer.subarray(offset + 4, frameLength));
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
    connection.frameBuffer = connection.frameBuffer.subarray(frameLength);

    if (opcode === 0x8) {
      closeConnection(connection);
    } else if (opcode === 0x9) {
      sendFrame(connection, 0xa, payload);
    } else if (opcode === 0xa) {
      onPong();
    } else {
      closeConnection(connection, 1003);
    }
  }
}

function safeHint(record: MobileNotificationRecord): string {
  const title = record.title
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, 300);
  const type = record.type
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .trim()
    .slice(0, 120);
  return JSON.stringify({
    type: "notification.hint",
    notificationId: record.id,
    eventId: record.sourceEventId,
    bugId: record.bugId,
    summary: `${title} [${type}]`.slice(0, 300),
  });
}

function sendNotificationHint(connection: HintConnection, record: MobileNotificationRecord): void {
  if (connection.sentNotificationIds.has(record.id)) return;
  sendFrame(connection, 0x1, Buffer.from(safeHint(record), "utf8"));
  connection.sentNotificationIds.add(record.id);
  while (connection.sentNotificationIds.size > MAX_SENT_NOTIFICATION_IDS) {
    const oldest = connection.sentNotificationIds.values().next().value as string | undefined;
    if (oldest === undefined) break;
    connection.sentNotificationIds.delete(oldest);
  }
}

export function startMobileNotificationHintChannel(
  options: MobileNotificationHintChannelOptions,
): MobileNotificationHintChannel {
  if (options.bearerToken.length === 0) {
    throw new Error("mobile notification hint bearerToken must not be empty");
  }

  const connections = new Set<HintConnection>();
  const now = options.now ?? (() => new Date());
  let stopped = false;
  let pollRunning = false;

  const removeConnection = (connection: HintConnection): void => {
    connections.delete(connection);
    closeConnection(connection);
  };

  const acceptUpgrade = async (
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "", "http://qa-hub.local").pathname;
    } catch {
      sendHttpError(socket, 400, "Bad Request");
      return;
    }
    if (pathname !== MOBILE_NOTIFICATION_HINT_PATH) {
      sendHttpError(socket, 404, "Not Found");
      return;
    }
    if (!isUpgradeRequest(request)) {
      sendHttpError(socket, 400, "Bad Request");
      return;
    }

    const protocols = headerTokens(request.headers["sec-websocket-protocol"]);
    const expectedProtocolToken = `bearer.${options.bearerToken}`;
    const bearerAuthenticated =
      headerValue(request.headers.authorization) === `Bearer ${options.bearerToken}` ||
      protocols.includes(expectedProtocolToken);
    const cookieHeader = headerValue(request.headers.cookie);
    let actorId: string | null = bearerAuthenticated ? options.actorId : null;
    if (
      actorId === null &&
      cookieHeader !== undefined &&
      options.resolveBrowserSession !== undefined
    ) {
      actorId = await options.resolveBrowserSession(cookieHeader);
    }
    if (actorId === null) {
      sendHttpError(socket, 401, "Unauthorized");
      return;
    }

    const key = headerValue(request.headers["sec-websocket-key"]);
    if (key === undefined || !/^[A-Za-z0-9+/]{22}==$/u.test(key)) {
      sendHttpError(socket, 400, "Bad Request");
      return;
    }
    const selectedProtocol = protocols.includes(MOBILE_NOTIFICATION_HINT_PROTOCOL)
      ? MOBILE_NOTIFICATION_HINT_PROTOCOL
      : undefined;
    const responseHeaders = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
      ...(selectedProtocol === undefined ? [] : [`Sec-WebSocket-Protocol: ${selectedProtocol}`]),
      "\r\n",
    ];
    socket.write(responseHeaders.join("\r\n"));
    socket.setNoDelay(true);

    const onData = (chunk: Buffer): void => {
      connection.frameBuffer = Buffer.concat([connection.frameBuffer, chunk]);
      parseFrames(connection, () => {
        connection.lastPongAt = Date.now();
      });
    };
    const onError = (): void => removeConnection(connection);
    const onClose = (): void => {
      connections.delete(connection);
      connection.closed = true;
      connection.socket.removeListener("error", connection.onError);
      connection.socket.removeListener("close", connection.onClose);
    };
    const connection: HintConnection = {
      socket,
      actorId,
      sentNotificationIds: new Set(),
      onData,
      onError,
      onClose,
      lastPongAt: Date.now(),
      frameBuffer: Buffer.alloc(0),
      closed: false,
    };
    connections.add(connection);
    socket.on("data", connection.onData);
    socket.on("error", connection.onError);
    socket.on("close", connection.onClose);
    if (head.length > 0) connection.onData(head);
    void poll();
  };

  const onUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    void acceptUpgrade(request, socket, head).catch((error: unknown) => {
      options.logger?.warn?.({ error }, "notification hint authentication failed");
      sendHttpError(socket, 401, "Unauthorized");
    });
  };

  const poll = async (): Promise<void> => {
    if (stopped || pollRunning) return;
    pollRunning = true;
    try {
      // listNotifications is the durable materialization/read path. Hints are
      // emitted only from its committed result; this channel stores no facts.
      const actorResults = new Map<
        string,
        Awaited<ReturnType<MobileNotificationStore["listNotifications"]>>
      >();
      await Promise.all(
        [...new Set([...connections].map((connection) => connection.actorId))].map(
          async (actorId) => {
            try {
              actorResults.set(
                actorId,
                await options.store.listNotifications({
                  actorId,
                  limit: 100,
                  now: now().toISOString(),
                }),
              );
            } catch (error: unknown) {
              options.logger?.warn?.(
                { error, actorId },
                "notification hint materialization failed",
              );
            }
          },
        ),
      );
      for (const connection of connections) {
        const result = actorResults.get(connection.actorId);
        if (result === undefined) continue;
        for (const notification of result.items) {
          sendNotificationHint(connection, notification);
        }
      }
    } catch (error: unknown) {
      options.logger?.warn?.({ error }, "notification hint materialization failed");
    } finally {
      pollRunning = false;
    }
  };

  const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  pollTimer.unref();
  const heartbeatTimer = setInterval(() => {
    const timestamp = Date.now();
    for (const connection of connections) {
      if (timestamp - connection.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        removeConnection(connection);
      } else {
        sendFrame(connection, 0x9);
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
  options.server.on("upgrade", onUpgrade);

  return {
    async close(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      options.server.off("upgrade", onUpgrade);
      for (const connection of connections) removeConnection(connection);
      connections.clear();
      while (pollRunning) await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}
