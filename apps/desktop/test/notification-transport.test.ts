import assert from "node:assert/strict";
import test from "node:test";

import {
  INBOX_RETRY_BASE_DELAY_MS,
  MAX_PENDING_EVENTS,
  MAX_PENDING_NOTIFICATIONS,
  MAX_SEEN_NOTIFICATIONS,
  NotificationTransport,
  parseDurableInbox,
  parseSafePushEvent,
  type NotificationSocket,
} from "../src/notification-transport.js";

const NOTIFICATION_ID = "10000000-0000-4000-8000-000000000001";
const EVENT_ID = "20000000-0000-4000-8000-000000000001";
const BUG_ID = "30000000-0000-4000-8000-000000000001";
const PROJECT_ID = "40000000-0000-4000-8000-000000000001";
const USER_ID = "50000000-0000-4000-8000-000000000001";

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
    projectId: PROJECT_ID,
    userId: USER_ID,
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

function controlledTimeouts() {
  let nextId = 1;
  const pending = new Map<number, { readonly callback: () => void; readonly delayMs: number }>();
  const setTimeoutFn = ((
    callback: (...args: unknown[]) => void,
    delayMs = 0,
    ...args: unknown[]
  ) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, { callback: () => callback(...args), delayMs });
    return id as unknown as ReturnType<typeof globalThis.setTimeout>;
  }) as typeof globalThis.setTimeout;
  const clearTimeoutFn = ((id: ReturnType<typeof globalThis.setTimeout>) => {
    pending.delete(id as unknown as number);
  }) as typeof globalThis.clearTimeout;
  return {
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    delays: () => [...pending.values()].map((entry) => entry.delayMs),
    runNext: () => {
      const next = [...pending.entries()].sort(
        ([firstId, first], [secondId, second]) =>
          first.delayMs - second.delayMs || firstId - secondId,
      )[0];
      if (next === undefined) return false;
      pending.delete(next[0]);
      next[1].callback();
      return true;
    },
  };
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
  assert.equal(parsed[0]?.projectId, PROJECT_ID);
  assert.equal(parsed[0]?.userId, USER_ID);
  assert.equal(parsed[0]?.bugId, BUG_ID);
  assert.equal(parsed[0]?.body, "QA-12 · Login button does not respond");
  assert.throws(() => parseDurableInbox({ items: [{ ...inboxItem(), extra: "secret" }] }));
  assert.throws(() =>
    parseDurableInbox({ items: [{ ...inboxItem(), projectId: undefined }], nextCursor: null }),
  );
  assert.throws(() =>
    parseDurableInbox({ items: [{ ...inboxItem(), userId: "not-a-uuid" }], nextCursor: null }),
  );
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
    showNotification: (notification) => {
      notifications.push(notification);
      return true;
    },
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
  assert.deepEqual(notifications[0], {
    notificationId: NOTIFICATION_ID,
    eventId: null,
    projectId: PROJECT_ID,
    userId: USER_ID,
    title: "这个单子已验收",
    body: "QA-12 · Login button does not respond",
    bugId: BUG_ID,
  });
  socket.closeFromPeer();
  transport.stop();
  assert.equal(notifications.length, 1);
});

test("persisted acknowledged IDs suppress unread Inbox replay after desktop restart", async () => {
  const socket = new FakeSocket();
  const notifications: unknown[] = [];
  const reconciliations: unknown[] = [];
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: "main-process-only",
    openSocket: () => socket,
    fetchInbox: async () =>
      parseDurableInbox({ items: [inboxItem()], nextCursor: null, unreadCount: 1 }),
    showNotification: (notification) => {
      notifications.push(notification);
      return true;
    },
    seenNotificationIds: [NOTIFICATION_ID],
    onReconcile: (result) => reconciliations.push(result),
  });
  transport.start();
  socket.open();
  await flush();
  transport.stop();
  assert.deepEqual(notifications, []);
  assert.deepEqual(reconciliations, [
    {
      generation: 1,
      notificationIds: [NOTIFICATION_ID],
      unreadNotificationIds: [NOTIFICATION_ID],
      locallyAcknowledgedNotificationIds: [NOTIFICATION_ID],
      presentationAttemptedNotificationIds: [],
    },
  ]);
});

test("a complete server-sized acknowledgement seed retains its oldest and newest IDs", async () => {
  const socket = new FakeSocket();
  const notifications: unknown[] = [];
  const acknowledgedIds = Array.from(
    { length: MAX_SEEN_NOTIFICATIONS },
    (_, index) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  );
  const oldest = acknowledgedIds[0]!;
  const newest = acknowledgedIds.at(-1)!;
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: "main-process-only",
    openSocket: () => socket,
    fetchInbox: async () => [
      { ...inboxItem(), id: newest },
      { ...inboxItem(), id: oldest },
    ],
    showNotification: (notification) => {
      notifications.push(notification);
      return true;
    },
    seenNotificationIds: acknowledgedIds,
  });
  transport.start();
  socket.open();
  await flush();
  assert.equal(
    transport.acknowledge(
      `10000000-0000-4000-8000-${String(MAX_SEEN_NOTIFICATIONS + 1).padStart(12, "0")}`,
    ),
    true,
  );
  await transport.reconcile();
  transport.stop();
  assert.deepEqual(notifications, []);
});

test("a complete snapshot keeps a bounded presentation window and rotates released slots", async () => {
  const socket = new FakeSocket();
  const baseTime = Date.parse("2026-08-25T12:00:00.000Z");
  const snapshot = Array.from({ length: MAX_SEEN_NOTIFICATIONS }, (_, index) => ({
    ...inboxItem(),
    id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    createdAt: new Date(baseTime - index).toISOString(),
  }));
  const attempts: string[] = [];
  const preparedBatches: string[][] = [];
  const settle = new Map<string, (acknowledged: boolean) => void>();
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: "main-process-only",
    openSocket: () => socket,
    fetchInbox: async () => [...snapshot].reverse(),
    prepareNotifications: (notifications) => {
      preparedBatches.push(notifications.map((notification) => notification.notificationId));
      return true;
    },
    showNotification: (notification) => {
      attempts.push(notification.notificationId);
      return new Promise<boolean>((resolve) => settle.set(notification.notificationId, resolve));
    },
  });

  transport.start();
  socket.open();
  await flush();
  assert.equal(attempts.length, MAX_PENDING_NOTIFICATIONS);
  assert.deepEqual(preparedBatches, [attempts]);
  assert.deepEqual(
    attempts,
    snapshot.slice(0, MAX_PENDING_NOTIFICATIONS).map((item) => item.id),
    "the newest notifications consume the initial bounded window",
  );
  await transport.reconcile();
  await transport.reconcile();
  assert.equal(attempts.length, MAX_PENDING_NOTIFICATIONS, "reconciliation cannot grow the window");

  const first = attempts[0]!;
  assert.equal(transport.acknowledge(first), true);
  settle.get(first)?.(false);
  await flush();
  await transport.reconcile();
  assert.equal(attempts.at(-1), snapshot[MAX_PENDING_NOTIFICATIONS]!.id);

  const second = attempts[1]!;
  settle.get(second)?.(false);
  await flush();
  await transport.reconcile();
  assert.equal(attempts.at(-1), snapshot[MAX_PENDING_NOTIFICATIONS + 1]!.id);

  const third = attempts[2]!;
  settle.get(third)?.(false);
  await flush();
  const hinted = snapshot.at(-1)!;
  socket.message(
    JSON.stringify({
      type: "notification.hint",
      notificationId: hinted.id,
      eventId: EVENT_ID,
      bugId: hinted.bugId,
      summary: hinted.body,
    }),
  );
  await flush();
  assert.equal(attempts.at(-1), hinted.id, "the exact hinted item takes the released slot first");
  await transport.reconcile();
  assert.equal(
    attempts.length,
    MAX_PENDING_NOTIFICATIONS + 3,
    "the active presentation count remains bounded after repeated reconciliation",
  );
  transport.stop();
});

test("a 21st unread item automatically fills a released bounded presentation slot", async () => {
  const socket = new FakeSocket();
  const timers = controlledTimeouts();
  const snapshot = Array.from({ length: MAX_PENDING_NOTIFICATIONS + 2 }, (_, index) => ({
    ...inboxItem(),
    id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    createdAt: new Date(Date.parse("2026-08-25T12:00:00.000Z") - index).toISOString(),
  }));
  const attempts: string[] = [];
  const settle = new Map<string, (acknowledged: boolean) => void>();
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: "main-process-only",
    openSocket: () => socket,
    fetchInbox: async () => snapshot,
    showNotification: (notification) => {
      attempts.push(notification.notificationId);
      return new Promise<boolean>((resolve) => settle.set(notification.notificationId, resolve));
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  transport.start();
  socket.open();
  await flush();
  assert.equal(attempts.length, MAX_PENDING_NOTIFICATIONS);

  settle.get(attempts[0]!)?.(true);
  await flush();
  assert.deepEqual(timers.delays(), [0], "an acknowledged slot schedules an immediate refill");
  assert.equal(timers.runNext(), true);
  await flush();
  assert.equal(attempts.at(-1), snapshot[MAX_PENDING_NOTIFICATIONS]!.id);

  settle.get(attempts[1]!)?.(false);
  await flush();
  assert.deepEqual(
    timers.delays(),
    [INBOX_RETRY_BASE_DELAY_MS],
    "a closed or failed presentation uses the retry backoff",
  );
  assert.equal(timers.runNext(), true);
  await flush();
  assert.equal(attempts.at(-1), snapshot[MAX_PENDING_NOTIFICATIONS + 1]!.id);
  transport.stop();
});

test("a shared native budget blocks capacity rotation and refills exactly one released slot", async () => {
  const socket = new FakeSocket();
  const timers = controlledTimeouts();
  const snapshot = Array.from({ length: MAX_PENDING_NOTIFICATIONS + 1 }, (_, index) => ({
    ...inboxItem(),
    id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    createdAt: new Date(Date.parse("2026-08-25T12:00:00.000Z") - index).toISOString(),
  }));
  const attempts: string[] = [];
  const settle = new Map<string, (acknowledged: boolean) => void>();
  let bugPendingLimit = MAX_PENDING_NOTIFICATIONS;
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: "main-process-only",
    openSocket: () => socket,
    fetchInbox: async () => snapshot,
    maxPendingNotifications: () => bugPendingLimit,
    showNotification: (notification) => {
      attempts.push(notification.notificationId);
      return new Promise<boolean>((resolve) => settle.set(notification.notificationId, resolve));
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  transport.start();
  socket.open();
  await flush();
  assert.equal(attempts.length, MAX_PENDING_NOTIFICATIONS);

  // A packaging or update toast takes the just-released shared slot. The
  // transport must not rotate notification 21 into another occupied slot.
  bugPendingLimit = MAX_PENDING_NOTIFICATIONS - 1;
  settle.get(attempts[0]!)?.(false);
  await flush();
  assert.deepEqual(timers.delays(), [INBOX_RETRY_BASE_DELAY_MS]);
  assert.equal(timers.runNext(), true);
  await flush();
  assert.equal(attempts.length, MAX_PENDING_NOTIFICATIONS);

  // Releasing that non-Bug reference raises the dynamic limit and explicitly
  // requests one coalesced refill.
  bugPendingLimit = MAX_PENDING_NOTIFICATIONS;
  assert.equal(transport.requestReconcile(), true);
  assert.deepEqual(timers.delays(), [0]);
  assert.equal(timers.runNext(), true);
  await flush();
  assert.equal(attempts.length, MAX_PENDING_NOTIFICATIONS + 1);
  assert.equal(attempts.at(-1), snapshot.at(-1)?.id);
  transport.stop();
});

test("retained or non-Bug references reduce the initial Bug window fail closed", async () => {
  const socket = new FakeSocket();
  const timers = controlledTimeouts();
  const snapshot = Array.from({ length: MAX_PENDING_NOTIFICATIONS }, (_, index) => ({
    ...inboxItem(),
    id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    createdAt: new Date(Date.parse("2026-08-25T12:00:00.000Z") - index).toISOString(),
  }));
  const attempts: string[] = [];
  let bugPendingLimit = MAX_PENDING_NOTIFICATIONS - 1;
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: "main-process-only",
    openSocket: () => socket,
    fetchInbox: async () => snapshot,
    maxPendingNotifications: () => bugPendingLimit,
    showNotification: (notification) => {
      attempts.push(notification.notificationId);
      return new Promise<boolean>(() => undefined);
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  transport.start();
  socket.open();
  await flush();
  assert.equal(attempts.length, MAX_PENDING_NOTIFICATIONS - 1);

  bugPendingLimit = MAX_PENDING_NOTIFICATIONS;
  assert.equal(transport.requestReconcile(), true);
  assert.equal(timers.runNext(), true);
  await flush();
  assert.equal(attempts.length, MAX_PENDING_NOTIFICATIONS);
  transport.stop();
});

test("an invalid dynamic native budget fails closed", async () => {
  const socket = new FakeSocket();
  let attempts = 0;
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: "main-process-only",
    openSocket: () => socket,
    fetchInbox: async () => [inboxItem()],
    maxPendingNotifications: () => {
      throw new Error("budget unavailable");
    },
    showNotification: () => {
      attempts += 1;
      return true;
    },
  });
  transport.start();
  socket.open();
  await flush();
  assert.equal(attempts, 0);
  transport.stop();
});

test("failed presentations back off without an unsupported-notification loop", async () => {
  const socket = new FakeSocket();
  const timers = controlledTimeouts();
  let reads = 0;
  let attempts = 0;
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: "main-process-only",
    openSocket: () => socket,
    fetchInbox: async () => {
      reads += 1;
      return [inboxItem()];
    },
    showNotification: () => {
      attempts += 1;
      return false;
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  transport.start();
  socket.open();
  await flush();
  assert.equal(reads, 1);
  assert.equal(attempts, 1);
  assert.deepEqual(timers.delays(), [INBOX_RETRY_BASE_DELAY_MS]);

  assert.equal(timers.runNext(), true);
  await flush();
  assert.equal(reads, 2);
  assert.equal(attempts, 2);
  assert.deepEqual(timers.delays(), [INBOX_RETRY_BASE_DELAY_MS * 2]);
  transport.stop();
});

test("Inbox fetch and batch preparation failures retry with one shared backoff", async () => {
  const socket = new FakeSocket();
  const timers = controlledTimeouts();
  let reads = 0;
  let preparationAttempts = 0;
  let presentations = 0;
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: "main-process-only",
    openSocket: () => socket,
    fetchInbox: async () => {
      reads += 1;
      if (reads === 1) throw new Error("transient fetch failure");
      return [inboxItem()];
    },
    prepareNotifications: () => {
      preparationAttempts += 1;
      if (preparationAttempts === 1) return false;
      if (preparationAttempts === 2) throw new Error("transient persistence failure");
      return true;
    },
    showNotification: () => {
      presentations += 1;
      return true;
    },
    onReconcile: () => {
      throw new Error("observability failure");
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  transport.start();
  socket.open();
  await flush();
  assert.deepEqual(timers.delays(), [INBOX_RETRY_BASE_DELAY_MS]);
  for (const expectedDelay of [INBOX_RETRY_BASE_DELAY_MS * 2, INBOX_RETRY_BASE_DELAY_MS * 4]) {
    assert.equal(timers.runNext(), true);
    await flush();
    assert.deepEqual(timers.delays(), [expectedDelay]);
  }
  assert.equal(timers.runNext(), true);
  await flush();
  assert.equal(reads, 4);
  assert.equal(preparationAttempts, 3);
  assert.equal(presentations, 1);
  assert.deepEqual(timers.delays(), []);
  transport.stop();
});

test("stop, pause, and credential changes cancel a pending Inbox retry", async () => {
  for (const lifecycle of ["stop", "pause", "credential"] as const) {
    const socket = new FakeSocket();
    const timers = controlledTimeouts();
    let reads = 0;
    const transport = new NotificationTransport({
      socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
      accessToken: "main-process-only",
      openSocket: () => socket,
      fetchInbox: async () => {
        reads += 1;
        return [inboxItem()];
      },
      showNotification: () => false,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    transport.start();
    socket.open();
    await flush();
    assert.deepEqual(timers.delays(), [INBOX_RETRY_BASE_DELAY_MS]);
    if (lifecycle === "stop") transport.stop();
    else if (lifecycle === "pause") transport.pause();
    else transport.updateAccessToken(null);
    assert.deepEqual(timers.delays(), [], `${lifecycle} must cancel its pending retry`);
    assert.equal(timers.runNext(), false);
    assert.equal(reads, 1);
    transport.stop();
  }
});

test("failed batch preparation presents nothing and remains retryable", async () => {
  const socket = new FakeSocket();
  let prepared = false;
  let preparationAttempts = 0;
  let presentationAttempts = 0;
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: "main-process-only",
    openSocket: () => socket,
    fetchInbox: async () => [inboxItem()],
    prepareNotifications: () => {
      preparationAttempts += 1;
      return prepared;
    },
    showNotification: () => {
      presentationAttempts += 1;
      return true;
    },
  });
  transport.start();
  socket.open();
  await flush();
  assert.equal(preparationAttempts, 1);
  assert.equal(presentationAttempts, 0);

  prepared = true;
  await transport.reconcile();
  await flush();
  assert.equal(preparationAttempts, 2);
  assert.equal(presentationAttempts, 1);
  await transport.reconcile();
  assert.equal(presentationAttempts, 1);
  transport.stop();
});

test("failed Inbox reads never publish a successful reconciliation", async () => {
  const socket = new FakeSocket();
  const reconciliations: unknown[] = [];
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: "main-process-only",
    openSocket: () => socket,
    fetchInbox: async () => {
      throw new Error("timeout");
    },
    showNotification: () => true,
    onReconcile: (result) => reconciliations.push(result),
  });
  transport.start();
  socket.open();
  await flush();
  assert.deepEqual(reconciliations, []);
  assert.equal(transport.status.lastError, "INBOX_READ_FAILED");
  transport.stop();
});

test("a hint that races a stale socket-open read forces a post-hint Inbox read", async () => {
  const socket = new FakeSocket();
  const notifications: unknown[] = [];
  let resolveInitial: ((items: readonly ReturnType<typeof inboxItem>[]) => void) | undefined;
  const initial = new Promise<readonly ReturnType<typeof inboxItem>[]>((resolve) => {
    resolveInitial = resolve;
  });
  let reads = 0;
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: "main-process-only",
    openSocket: () => socket,
    fetchInbox: async () => {
      reads += 1;
      return reads === 1 ? initial : [inboxItem()];
    },
    showNotification: (notification) => {
      notifications.push(notification);
      return true;
    },
  });
  transport.start();
  socket.open();
  socket.message(
    JSON.stringify({
      type: "notification.hint",
      notificationId: NOTIFICATION_ID,
      eventId: EVENT_ID,
      bugId: BUG_ID,
      summary: "late durable row",
    }),
  );
  resolveInitial?.([]);
  await flush();
  await flush();
  assert.equal(reads, 2);
  assert.equal(notifications.length, 1);
  socket.message(
    JSON.stringify({
      type: "notification.hint",
      notificationId: NOTIFICATION_ID,
      eventId: EVENT_ID,
      bugId: BUG_ID,
      summary: "duplicate hint",
    }),
  );
  await flush();
  assert.equal(reads, 2, "the event is claimed only after its durable row is observed");
  transport.stop();
});

test("overflowed hints force a fresh generation after accepted post-hint reads drain", async () => {
  const socket = new FakeSocket();
  const timers = controlledTimeouts();
  let resolveInitial: ((items: readonly ReturnType<typeof inboxItem>[]) => void) | undefined;
  let resolveAcceptedHints: ((items: readonly ReturnType<typeof inboxItem>[]) => void) | undefined;
  const initial = new Promise<readonly ReturnType<typeof inboxItem>[]>((resolve) => {
    resolveInitial = resolve;
  });
  const acceptedHints = new Promise<readonly ReturnType<typeof inboxItem>[]>((resolve) => {
    resolveAcceptedHints = resolve;
  });
  const overflowIndex = MAX_PENDING_EVENTS + 1;
  const overflowItem = {
    ...inboxItem(),
    id: `10000000-0000-4000-8000-${String(overflowIndex).padStart(12, "0")}`,
  };
  const overflowEventId = `20000000-0000-4000-8000-${String(overflowIndex).padStart(12, "0")}`;
  let reads = 0;
  const attempts: string[] = [];
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: "main-process-only",
    openSocket: () => socket,
    fetchInbox: async () => {
      reads += 1;
      if (reads === 1) return initial;
      if (reads === 2) return acceptedHints;
      return [overflowItem];
    },
    showNotification: (notification) => {
      attempts.push(notification.notificationId);
      return true;
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  transport.start();
  socket.open();
  for (let index = 1; index <= overflowIndex; index += 1) {
    socket.message(
      JSON.stringify({
        type: "notification.hint",
        notificationId: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        eventId: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        bugId: null,
        summary: `hint ${index}`,
      }),
    );
  }
  resolveInitial?.([]);
  await flush();
  assert.equal(reads, 2);
  resolveAcceptedHints?.([]);
  await flush();
  await flush();
  assert.deepEqual(timers.delays(), [0]);

  assert.equal(timers.runNext(), true);
  await flush();
  assert.deepEqual(attempts, [overflowItem.id]);
  assert.equal(reads, 3, "the overflow drain must fetch a new durable generation");

  socket.message(
    JSON.stringify({
      type: "notification.hint",
      notificationId: overflowItem.id,
      eventId: overflowEventId,
      bugId: null,
      summary: "overflow hint replay",
    }),
  );
  await flush();
  assert.equal(reads, 4, "the overflow event ID must not be marked seen before it is accepted");
  assert.deepEqual(attempts, [overflowItem.id]);
  transport.stop();
});

test("a hint whose post-hint read is empty remains retryable", async () => {
  const socket = new FakeSocket();
  let durable = false;
  let attempts = 0;
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: "main-process-only",
    openSocket: () => socket,
    fetchInbox: async () => (durable ? [inboxItem()] : []),
    showNotification: () => {
      attempts += 1;
      return true;
    },
  });
  transport.start();
  socket.open();
  await flush();
  const hint = JSON.stringify({
    type: "notification.hint",
    notificationId: NOTIFICATION_ID,
    eventId: EVENT_ID,
    bugId: BUG_ID,
    summary: "eventual row",
  });
  socket.message(hint);
  await flush();
  assert.equal(attempts, 0);
  durable = true;
  socket.message(hint);
  await flush();
  await flush();
  assert.equal(attempts, 1);
  transport.stop();
});

test("pause prevents an in-flight Inbox read from showing a native notification", async () => {
  const socket = new FakeSocket();
  let resolveRead: ((items: readonly ReturnType<typeof inboxItem>[]) => void) | undefined;
  const pending = new Promise<readonly ReturnType<typeof inboxItem>[]>((resolve) => {
    resolveRead = resolve;
  });
  let attempts = 0;
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: "main-process-only",
    openSocket: () => socket,
    fetchInbox: async () => pending,
    showNotification: () => {
      attempts += 1;
      return true;
    },
  });
  transport.start();
  socket.open();
  transport.pause();
  resolveRead?.([inboxItem()]);
  await flush();
  assert.equal(attempts, 0);
  assert.equal(transport.status.state, "paused");
  transport.stop();
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
    showNotification: () => true,
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

test("a failed platform show remains retryable while an in-flight show is deduplicated", async () => {
  const socket = new FakeSocket();
  let attempts = 0;
  let finishFirst: ((shown: boolean) => void) | undefined;
  const firstDelivery = new Promise<boolean>((resolve) => {
    finishFirst = resolve;
  });
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: "main-process-only",
    openSocket: () => socket,
    fetchInbox: async () =>
      parseDurableInbox({ items: [inboxItem()], nextCursor: null, unreadCount: 1 }),
    showNotification: () => {
      attempts += 1;
      return attempts === 1 ? firstDelivery : true;
    },
  });

  transport.start();
  socket.open();
  await flush();
  await transport.reconcile();
  assert.equal(attempts, 1, "concurrent reconciliation must not duplicate an in-flight toast");

  finishFirst?.(false);
  await flush();
  await transport.reconcile();
  await flush();
  assert.equal(attempts, 2, "a failed native show remains unread and retryable");

  await transport.reconcile();
  assert.equal(attempts, 2, "a successful retry is retained in the replay guard");
  transport.stop();
});

test("an asynchronously settled no-event failure leaves the notification retryable", async () => {
  const socket = new FakeSocket();
  let attempts = 0;
  let settleNoEvent: ((shown: boolean) => void) | undefined;
  const noEventAttempt = new Promise<boolean>((resolve) => {
    settleNoEvent = resolve;
  });
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: "main-process-only",
    openSocket: () => socket,
    fetchInbox: async () =>
      parseDurableInbox({ items: [inboxItem()], nextCursor: null, unreadCount: 1 }),
    showNotification: () => {
      attempts += 1;
      return attempts === 1 ? noEventAttempt : true;
    },
  });

  transport.start();
  socket.open();
  await flush();
  await transport.reconcile();
  assert.equal(attempts, 1);
  settleNoEvent?.(false);
  await flush();
  await transport.reconcile();
  await flush();
  assert.equal(attempts, 2);
  transport.stop();
});

test("the same hint remains retryable until its native sink succeeds", async (context) => {
  const socket = new FakeSocket();
  let reads = 0;
  let attempts = 0;
  let settleFirst: ((acknowledged: boolean) => void) | undefined;
  const firstAttempt = new Promise<boolean>((resolve) => {
    settleFirst = resolve;
  });
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: "main-process-only",
    openSocket: () => socket,
    fetchInbox: async () => {
      reads += 1;
      return reads === 1 ? [] : [inboxItem()];
    },
    showNotification: () => {
      attempts += 1;
      if (attempts === 1) return firstAttempt;
      if (attempts === 2) return Promise.reject(new Error("platform failed"));
      return true;
    },
  });
  context.after(() => transport.stop());
  const hint = JSON.stringify({
    type: "notification.hint",
    notificationId: NOTIFICATION_ID,
    eventId: EVENT_ID,
    bugId: BUG_ID,
    summary: "retry the same durable hint",
  });

  transport.start();
  socket.open();
  await flush();
  socket.message(hint);
  await flush();
  assert.equal(reads, 2);
  assert.equal(attempts, 1);

  settleFirst?.(false);
  await flush();
  socket.message(hint);
  await flush();
  await flush();
  assert.equal(reads, 3);
  assert.equal(attempts, 2, "a false sink result must not claim the event ID");

  socket.message(hint);
  await flush();
  await flush();
  assert.equal(reads, 4);
  assert.equal(attempts, 3, "a rejected sink result must not claim the event ID");

  socket.message(hint);
  await flush();
  assert.equal(reads, 4, "a successful sink result claims the event ID");
  assert.equal(attempts, 3);
});

test("a hint for an already read durable notification is claimed without presentation", async (context) => {
  const socket = new FakeSocket();
  let reads = 0;
  let attempts = 0;
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: "main-process-only",
    openSocket: () => socket,
    fetchInbox: async () => {
      reads += 1;
      return [inboxItem("2026-08-25T12:01:00.000Z")];
    },
    showNotification: () => {
      attempts += 1;
      return true;
    },
  });
  context.after(() => transport.stop());
  const hint = JSON.stringify({
    type: "notification.hint",
    notificationId: NOTIFICATION_ID,
    eventId: EVENT_ID,
    bugId: BUG_ID,
    summary: "already read",
  });

  transport.start();
  socket.open();
  await flush();
  socket.message(hint);
  await flush();
  assert.equal(reads, 2);
  assert.equal(attempts, 0);
  socket.message(hint);
  await flush();
  assert.equal(reads, 2, "a durable read state claims the event ID");
  assert.equal(attempts, 0);
});

test("a global activation acknowledges a pending presentation before its promise settles", async () => {
  const socket = new FakeSocket();
  let attempts = 0;
  let settlePresentation: ((acknowledged: boolean) => void) | undefined;
  const presentation = new Promise<boolean>((resolve) => {
    settlePresentation = resolve;
  });
  const transport = new NotificationTransport({
    socketUrl: new URL("wss://qa.example.test/api/v1/notifications/stream"),
    accessToken: "main-process-only",
    openSocket: () => socket,
    fetchInbox: async () =>
      parseDurableInbox({ items: [inboxItem()], nextCursor: null, unreadCount: 1 }),
    showNotification: () => {
      attempts += 1;
      return presentation;
    },
  });

  transport.start();
  socket.open();
  await flush();
  assert.equal(attempts, 1);
  assert.equal(transport.acknowledge(NOTIFICATION_ID.toUpperCase()), true);
  assert.equal(transport.acknowledge("not-a-uuid"), false);
  settlePresentation?.(false);
  await flush();
  await transport.reconcile();
  assert.equal(attempts, 1, "a clicked toast must not replay after its pending delivery settles");
  transport.stop();
});
