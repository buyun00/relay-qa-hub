import assert from "node:assert/strict";
import test from "node:test";

import {
  NotificationTransport,
  parseDurableInbox,
  parseSafePushEvent,
  type NotificationSocket,
} from "../src/notification-transport.js";

const NOTIFICATION_ID = "10000000-0000-4000-8000-000000000001";
const EVENT_ID = "20000000-0000-4000-8000-000000000001";
const BUG_ID = "30000000-0000-4000-8000-000000000001";

class FakeSocket implements NotificationSocket {
  private readonly openListeners = new Set<() => void>();
  private readonly messageListeners = new Set<(payload: string) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly errorListeners = new Set<(code: string) => void>();
  private readonly pongListeners = new Set<() => void>();
  sent: string[] = [];
  closed = false;

  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  onMessage(listener: (payload: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onError(listener: (code: string) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onPong(listener: () => void): () => void {
    this.pongListeners.add(listener);
    return () => this.pongListeners.delete(listener);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  ping(): void {
    this.sent.push("<ping>");
    for (const listener of this.pongListeners) listener();
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    for (const listener of this.openListeners) listener();
  }

  message(payload: string): void {
    for (const listener of this.messageListeners) listener(payload);
  }

  closeFromPeer(): void {
    for (const listener of this.closeListeners) listener();
  }

  error(code: string): void {
    for (const listener of this.errorListeners) listener(code);
  }
}

function inboxItem(readAt: string | null = null) {
  return {
    id: NOTIFICATION_ID,
    projectId: "40000000-0000-4000-8000-000000000001",
    userId: "50000000-0000-4000-8000-000000000001",
    type: "bug.updated",
    title: "Bug changed",
    body: "QA-12 · Login button does not respond",
    bugId: BUG_ID,
    createdAt: "2026-08-25T12:00:00.000Z",
    readAt,
    version: 1,
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("push hints are strict, bounded, and do not carry arbitrary payloads", () => {
  const valid = parseSafePushEvent(
    JSON.stringify({
      type: "notification.hint",
      notificationId: NOTIFICATION_ID,
      eventId: EVENT_ID,
      bugId: BUG_ID,
      summary: "Bug moved to ready",
    }),
  );
  assert.deepEqual(valid, {
    type: "notification.hint",
    notificationId: NOTIFICATION_ID,
    eventId: EVENT_ID,
    bugId: BUG_ID,
    summary: "Bug moved to ready",
  });
  assert.equal(
    parseSafePushEvent(
      JSON.stringify({
        type: "notification.hint",
        notificationId: NOTIFICATION_ID,
        eventId: EVENT_ID,
        bugId: BUG_ID,
        summary: "safe",
        payload: { secret: "must be rejected" },
      }),
    ),
    null,
  );
  assert.equal(parseSafePushEvent(JSON.stringify({ type: "other" })), null);
});

test("Inbox parser preserves only bounded notification fields", () => {
  const parsed = parseDurableInbox({ items: [inboxItem()], nextCursor: null, unreadCount: 1 });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.bugId, BUG_ID);
  assert.equal(parsed[0]?.body, "QA-12 · Login button does not respond");
  assert.throws(() => parseDurableInbox({ items: [{ ...inboxItem(), extra: "secret" }] }));
});

test("transport fetches durable Inbox once, dedupes reconnect replay, and deep-links Bug", async () => {
  const socket = new FakeSocket();
  const notifications: unknown[] = [];
  let inboxReads = 0;
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: "main-process-only",
    openSocket: () => socket,
    fetchInbox: async () => {
      inboxReads += 1;
      return parseDurableInbox({
        items: [{ ...inboxItem(), type: "verification.result_recorded", title: "这个单子已验收" }],
        nextCursor: null,
        unreadCount: 1,
      });
    },
    showNotification: (notification) => notifications.push(notification),
  });
  transport.start();
  socket.open();
  await flush();
  socket.message(
    JSON.stringify({
      type: "notification.hint",
      notificationId: NOTIFICATION_ID,
      eventId: EVENT_ID,
      bugId: BUG_ID,
      summary: "有一个新单子",
    }),
  );
  await flush();
  assert.equal(inboxReads, 2);
  assert.equal(notifications.length, 1);
  assert.equal((notifications[0] as { readonly bugId: string }).bugId, BUG_ID);
  assert.equal((notifications[0] as { readonly title: string }).title, "这个单子已验收");
  assert.equal(
    (notifications[0] as { readonly body: string }).body,
    "QA-12 · Login button does not respond",
  );
  socket.closeFromPeer();
  transport.stop();
  assert.equal(notifications.length, 1);
});

test("persisted delivered IDs suppress unread Inbox replay after desktop restart", async () => {
  const socket = new FakeSocket();
  const notifications: unknown[] = [];
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: "main-process-only",
    openSocket: () => socket,
    fetchInbox: async () =>
      parseDurableInbox({ items: [inboxItem()], nextCursor: null, unreadCount: 1 }),
    showNotification: (notification) => notifications.push(notification),
    seenNotificationIds: [NOTIFICATION_ID],
  });
  transport.start();
  socket.open();
  await flush();
  transport.stop();
  assert.deepEqual(notifications, []);
});

test("a browser login enables a transport that started without a shared credential", async () => {
  const socket = new FakeSocket();
  const openedWith: string[] = [];
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: null,
    openSocket: (_url, credential) => {
      openedWith.push(credential);
      return socket;
    },
    fetchInbox: async () => [],
    showNotification: () => undefined,
  });

  transport.start();
  assert.equal(transport.status.state, "disabled");
  transport.updateAccessToken(`qa_hub_browser_session=${"A".repeat(43)}`);
  assert.deepEqual(openedWith, [`qa_hub_browser_session=${"A".repeat(43)}`]);
  socket.open();
  await flush();
  assert.equal(transport.status.state, "connected");

  transport.updateAccessToken(null);
  assert.equal(socket.closed, true);
  assert.equal(transport.status.state, "disabled");
  transport.stop();
});
