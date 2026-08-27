import { randomBytes, createHash } from "node:crypto";
import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";

import type { NotificationSocket } from "./notification-transport.js";

const MAX_HANDSHAKE_BYTES = 16 * 1024;
const MAX_FRAME_BYTES = 256 * 1024;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const BROWSER_SESSION_COOKIE_PATTERN = /^qa_hub_browser_session=[A-Za-z0-9_-]{43}$/u;

type VoidListener = () => void;
type ErrorListener = (code: string) => void;
type MessageListener = (payload: string) => void;

function headerValue(headers: readonly string[], name: string): string | null {
  const prefix = `${name.toLowerCase()}:`;
  const line = headers.find((candidate) => candidate.toLowerCase().startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length).trim();
}

function closeCode(code: number): Buffer {
  const payload = Buffer.allocUnsafe(2);
  payload.writeUInt16BE(code, 0);
  return payload;
}

export class AuthenticatedWssClient implements NotificationSocket {
  private readonly socket: Socket;
  private readonly openListeners = new Set<VoidListener>();
  private readonly messageListeners = new Set<MessageListener>();
  private readonly closeListeners = new Set<VoidListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly pongListeners = new Set<VoidListener>();
  private handshakeBuffer = Buffer.alloc(0);
  private frameBuffer = Buffer.alloc(0);
  private handshakeComplete = false;
  private closed = false;
  private closeNotified = false;
  private failureNotified = false;

  constructor(
    url: URL,
    credential: string,
    authenticationKind: "bearer" | "browser-session" = "bearer",
  ) {
    if (url.protocol !== "wss:" && url.protocol !== "ws:") {
      throw new Error("WSS_URL_PROTOCOL_INVALID");
    }
    if (credential.trim().length === 0) throw new Error("ACCESS_TOKEN_MISSING");
    if (
      authenticationKind === "browser-session" &&
      !BROWSER_SESSION_COOKIE_PATTERN.test(credential)
    ) {
      throw new Error("BROWSER_SESSION_COOKIE_INVALID");
    }
    const port = url.port.length === 0 ? (url.protocol === "wss:" ? 443 : 80) : Number(url.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
      throw new Error("WSS_URL_PORT_INVALID");
    const host = url.hostname;
    const key = randomBytes(16).toString("base64");
    const requestPath = `${url.pathname.length === 0 ? "/" : url.pathname}${url.search}`;
    const hostHeader = url.host;
    const request = [
      `GET ${requestPath} HTTP/1.1`,
      `Host: ${hostHeader}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      authenticationKind === "bearer"
        ? `Authorization: Bearer ${credential}`
        : `Cookie: ${credential}`,
      "User-Agent: Relay-QA-Hub-Desktop",
      "",
      "",
    ].join("\r\n");
    this.expectedKeySource = key;
    this.socket =
      url.protocol === "wss:"
        ? connectTls({ host, port, servername: host, rejectUnauthorized: true })
        : connectTcp({ host, port });
    this.socket.setNoDelay(true);
    this.socket.on(url.protocol === "wss:" ? "secureConnect" : "connect", () => {
      if (!this.closed) this.socket.write(request);
    });
    this.socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    this.socket.on("error", () => this.fail("SOCKET_ERROR"));
    this.socket.on("close", () => this.handleClose());
  }

  onOpen(listener: VoidListener): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: VoidListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onPong(listener: VoidListener): () => void {
    this.pongListeners.add(listener);
    return () => this.pongListeners.delete(listener);
  }

  send(payload: string): void {
    if (!this.handshakeComplete || this.closed) throw new Error("WSS_NOT_OPEN");
    const bytes = Buffer.from(payload, "utf8");
    this.writeFrame(0x1, bytes);
  }

  ping(): void {
    if (!this.handshakeComplete || this.closed) throw new Error("WSS_NOT_OPEN");
    this.writeFrame(0x9, Buffer.alloc(0));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.handshakeComplete && !this.socket.destroyed) {
      try {
        this.writeFrame(0x8, closeCode(1000));
      } catch {
        // The underlying socket is closed below even if the close frame cannot be sent.
      }
    }
    this.socket.end();
  }

  private handleData(chunk: Buffer): void {
    if (this.closed) return;
    if (!this.handshakeComplete) {
      this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk]);
      if (this.handshakeBuffer.length > MAX_HANDSHAKE_BYTES) {
        this.fail("WSS_HANDSHAKE_TOO_LARGE");
        return;
      }
      const headerEnd = this.handshakeBuffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const headerText = this.handshakeBuffer.subarray(0, headerEnd).toString("ascii");
      const remainder = this.handshakeBuffer.subarray(headerEnd + 4);
      this.handshakeBuffer = Buffer.alloc(0);
      if (!this.acceptHandshake(headerText)) return;
      this.handshakeComplete = true;
      for (const listener of this.openListeners) listener();
      if (remainder.length > 0) this.handleFrames(remainder);
      return;
    }
    this.handleFrames(chunk);
  }

  private acceptHandshake(headerText: string): boolean {
    const lines = headerText.split("\r\n");
    const status = lines.shift();
    const accept = headerValue(lines, "sec-websocket-accept");
    const expected = createHash("sha1")
      .update(this.expectedKeySource + WEBSOCKET_GUID)
      .digest("base64");
    if (status !== "HTTP/1.1 101 Switching Protocols" || accept !== expected) {
      this.fail("WSS_HANDSHAKE_REJECTED");
      return false;
    }
    return true;
  }

  // The handshake key is read back from the request only through this stable
  // value. It is kept private and is never included in logs or IPC payloads.
  private readonly expectedKeySource: string;

  private handleFrames(chunk: Buffer): void {
    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);
    while (this.frameBuffer.length >= 2 && !this.closed) {
      const first = this.frameBuffer[0];
      const second = this.frameBuffer[1];
      if (first === undefined || second === undefined) return;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (!fin) {
        this.fail("WSS_FRAGMENTED_FRAME");
        return;
      }
      if (length === 126) {
        if (this.frameBuffer.length < offset + 2) return;
        length = this.frameBuffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.frameBuffer.length < offset + 8) return;
        const lengthBig = this.frameBuffer.readBigUInt64BE(offset);
        if (lengthBig > BigInt(MAX_FRAME_BYTES)) {
          this.fail("WSS_FRAME_TOO_LARGE");
          return;
        }
        length = Number(lengthBig);
        offset += 8;
      }
      if (length > MAX_FRAME_BYTES) {
        this.fail("WSS_FRAME_TOO_LARGE");
        return;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.frameBuffer.length < offset + length) return;
      const mask = masked ? this.frameBuffer.subarray(maskOffset, maskOffset + 4) : null;
      const payload = Buffer.from(this.frameBuffer.subarray(offset, offset + length));
      this.frameBuffer = this.frameBuffer.subarray(offset + length);
      if (mask !== null) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
        }
      }
      if (opcode === 0x8) {
        this.close();
      } else if (opcode === 0x9) {
        this.writeFrame(0xa, payload);
      } else if (opcode === 0xa) {
        for (const listener of this.pongListeners) listener();
      } else if (opcode === 0x1) {
        for (const listener of this.messageListeners) listener(payload.toString("utf8"));
      } else if (opcode !== 0x0) {
        this.fail("WSS_OPCODE_UNSUPPORTED");
      }
    }
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (payload.length > MAX_FRAME_BYTES) throw new Error("WSS_FRAME_TOO_LARGE");
    const mask = randomBytes(4);
    const headerLength = payload.length < 126 ? 2 : payload.length <= 65_535 ? 4 : 10;
    const frame = Buffer.allocUnsafe(headerLength + 4 + payload.length);
    frame[0] = 0x80 | opcode;
    if (payload.length < 126) {
      frame[1] = 0x80 | payload.length;
    } else if (payload.length <= 65_535) {
      frame[1] = 0x80 | 126;
      frame.writeUInt16BE(payload.length, 2);
    } else {
      frame[1] = 0x80 | 127;
      frame.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    mask.copy(frame, headerLength);
    for (let index = 0; index < payload.length; index += 1) {
      frame[headerLength + 4 + index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
    this.socket.write(frame);
  }

  private fail(code: string): void {
    if (!this.failureNotified) {
      this.failureNotified = true;
      for (const listener of this.errorListeners) listener(code);
    }
    if (!this.closed) {
      this.closed = true;
      this.socket.destroy();
    }
  }

  private handleClose(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    for (const listener of this.closeListeners) listener();
  }
}

export function createAuthenticatedWssClient(url: URL, accessToken: string): NotificationSocket {
  return new AuthenticatedWssClient(url, accessToken);
}

export function createBrowserSessionWssClient(
  url: URL,
  browserSessionCookie: string,
): NotificationSocket {
  return new AuthenticatedWssClient(url, browserSessionCookie, "browser-session");
}
