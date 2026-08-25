import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Socket } from "node:net";
import test from "node:test";

import { createAuthenticatedWssClient } from "../src/wss-client.js";

const EVENT = JSON.stringify({
  type: "notification.hint",
  notificationId: "10000000-0000-4000-8000-000000000001",
  eventId: "20000000-0000-4000-8000-000000000001",
  bugId: "30000000-0000-4000-8000-000000000001",
  summary: "bounded",
});

function textFrame(payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

test("authenticated WebSocket client completes RFC6455 101 and reads a bounded text hint", async () => {
  const server = createServer();
  let acceptedSocket: Socket | null = null;
  const serverReady = new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("server address missing");
      resolve(address.port);
    });
  });
  server.on("connection", (socket) => {
    acceptedSocket = socket;
    let request = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      request = Buffer.concat([request, chunk]);
      const end = request.indexOf("\r\n\r\n");
      if (end < 0) return;
      const header = request.subarray(0, end).toString("ascii");
      const keyLine = header
        .split("\r\n")
        .find((line) => line.toLowerCase().startsWith("sec-websocket-key:"));
      const key = keyLine?.slice(keyLine.indexOf(":") + 1).trim();
      assert.equal(header.includes("Authorization: Bearer test-token"), true);
      assert.ok(key);
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.write(textFrame(EVENT));
    });
  });
  try {
    const port = await serverReady;
    const socket = createAuthenticatedWssClient(
      new URL(`ws://127.0.0.1:${port}/api/v1/notifications/stream`),
      "test-token",
    );
    const message = new Promise<string>((resolve) => socket.onMessage(resolve));
    const opened = new Promise<void>((resolve) => socket.onOpen(resolve));
    await opened;
    assert.equal(await message, EVENT);
    socket.close();
  } finally {
    acceptedSocket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
