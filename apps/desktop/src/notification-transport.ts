const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const MAX_PUSH_BYTES = 16 * 1024;
export const MAX_INBOX_ITEMS = 100;
export const MAX_INBOX_BYTES = 256 * 1024;
export const MAX_SUMMARY_LENGTH = 300;
export const MAX_SEEN_NOTIFICATIONS = 512;
export const HEARTBEAT_INTERVAL_MS = 25_000;
export const HEARTBEAT_TIMEOUT_MS = 75_000;
export const MAX_RECONNECT_DELAY_MS = 60_000;

export interface SafePushEvent {
  readonly type: "notification.hint";
  readonly notificationId: string;
  readonly eventId: string;
  readonly summary: string;
  readonly bugId: string | null;
}

export interface DurableNotification {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly bugId: string | null;
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly version: number;
}

export interface DesktopNotification {
  readonly notificationId: string;
  readonly eventId: string | null;
  readonly title: string;
  readonly body: string;
  readonly bugId: string | null;
}

export type TransportState =
  "disabled" | "stopped" | "connecting" | "connected" | "reconnecting" | "paused";

export interface TransportStatus {
  readonly state: TransportState;
  readonly reconnectAttempt: number;
  readonly lastError: string | null;
}

export interface NotificationSocket {
  onOpen(listener: () => void): () => void;
  onMessage(listener: (payload: string) => void): () => void;
  onClose(listener: () => void): () => void;
  onError(listener: (code: string) => void): () => void;
  onPong?(listener: () => void): () => void;
  send(payload: string): void;
  ping?(): void;
  close(): void;
}

export type NotificationSocketFactory = (url: URL, accessToken: string) => NotificationSocket;
export type InboxFetcher = () => Promise<readonly DurableNotification[]>;
export type NotificationSink = (notification: DesktopNotification) => void;
export type TransportStatusListener = (status: TransportStatus) => void;

export interface NotificationTransportOptions {
  readonly socketUrl: URL;
  readonly accessToken: string | null;
  readonly openSocket: NotificationSocketFactory;
  readonly fetchInbox: InboxFetcher;
  readonly showNotification: NotificationSink;
  readonly seenNotificationIds?: readonly string[];
  readonly onStatus?: TransportStatusListener;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
  readonly now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length === 0 ? null : normalized;
}

function nullableUuid(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) return undefined;
  return value.toLowerCase();
}

function requiredUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

export function parseSafePushEvent(payload: string): SafePushEvent | null {
  if (Buffer.byteLength(payload, "utf8") > MAX_PUSH_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const allowed = new Set(["type", "notificationId", "eventId", "bugId", "summary"]);
  if (!hasOnlyKeys(parsed, allowed)) return null;
  if (parsed["type"] !== "notification.hint") return null;
  const notificationId = requiredUuid(parsed["notificationId"]);
  const summary = boundedText(parsed["summary"], MAX_SUMMARY_LENGTH);
  const eventId = nullableUuid(parsed["eventId"]);
  const bugId = nullableUuid(parsed["bugId"]);
  if (
    notificationId === null ||
    summary === null ||
    eventId === null ||
    eventId === undefined ||
    bugId === undefined
  ) {
    return null;
  }
  return { type: "notification.hint", notificationId, eventId, summary, bugId };
}

export function parseDurableInbox(value: unknown): readonly DurableNotification[] {
  if (
    !isRecord(value) ||
    !Array.isArray(value["items"]) ||
    value["items"].length > MAX_INBOX_ITEMS
  ) {
    throw new Error("INVALID_INBOX_RESPONSE");
  }
  const items: DurableNotification[] = [];
  for (const itemValue of value["items"]) {
    if (!isRecord(itemValue)) throw new Error("INVALID_INBOX_ITEM");
    const allowed = new Set([
      "id",
      "projectId",
      "userId",
      "type",
      "title",
      "body",
      "bugId",
      "createdAt",
      "readAt",
      "version",
    ]);
    if (!hasOnlyKeys(itemValue, allowed)) throw new Error("INVALID_INBOX_ITEM");
    const id = requiredUuid(itemValue["id"]);
    const type = boundedText(itemValue["type"], 120);
    const title = boundedText(itemValue["title"], MAX_SUMMARY_LENGTH);
    const body = itemValue["body"] === undefined ? type : boundedText(itemValue["body"], 500);
    const bugId = nullableUuid(itemValue["bugId"]);
    const createdAt = boundedText(itemValue["createdAt"], 100);
    const readAt = itemValue["readAt"] === null ? null : boundedText(itemValue["readAt"], 100);
    const version = itemValue["version"];
    if (
      id === null ||
      type === null ||
      title === null ||
      body === null ||
      bugId === undefined ||
      createdAt === null ||
      (itemValue["readAt"] !== null && readAt === null) ||
      !Number.isSafeInteger(version) ||
      (version as number) < 1 ||
      !Number.isFinite(Date.parse(createdAt)) ||
      (readAt !== null && !Number.isFinite(Date.parse(readAt)))
    ) {
      throw new Error("INVALID_INBOX_ITEM");
    }
    items.push({
      id,
      type,
      title,
      body,
      bugId,
      createdAt,
      readAt,
      version: version as number,
    });
  }
  return items;
}

class BoundedSet {
  private readonly values = new Set<string>();

  constructor(private readonly maxSize: number) {}

  has(value: string): boolean {
    return this.values.has(value);
  }

  add(value: string): void {
    this.values.delete(value);
    this.values.add(value);
    while (this.values.size > this.maxSize) {
      const oldest = this.values.values().next().value as string | undefined;
      if (oldest === undefined) return;
      this.values.delete(oldest);
    }
  }
}

export class NotificationTransport {
  private readonly setTimeoutFn: typeof globalThis.setTimeout;
  private readonly clearTimeoutFn: typeof globalThis.clearTimeout;
  private readonly setIntervalFn: typeof globalThis.setInterval;
  private readonly clearIntervalFn: typeof globalThis.clearInterval;
  private readonly now: () => number;
  private readonly seenNotifications: BoundedSet;
  private readonly seenEvents = new BoundedSet(MAX_SEEN_NOTIFICATIONS);
  private readonly statusListeners = new Set<TransportStatusListener>();
  private readonly options: NotificationTransportOptions;
  private accessToken: string | null;
  private socket: NotificationSocket | null = null;
  private socketUnsubscribers: readonly (() => void)[] = [];
  private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private reconnectAttempt = 0;
  private lastActivityAt = 0;
  private running = false;
  private paused = false;
  private inboxRead: Promise<readonly DurableNotification[]> | null = null;
  private currentStatus: TransportStatus;

  constructor(options: NotificationTransportOptions) {
    this.options = options;
    this.accessToken = options.accessToken;
    this.seenNotifications = new BoundedSet(MAX_SEEN_NOTIFICATIONS);
    for (const notificationId of options.seenNotificationIds ?? []) {
      if (UUID_PATTERN.test(notificationId))
        this.seenNotifications.add(notificationId.toLowerCase());
    }
    this.setTimeoutFn = options.setTimeout ?? globalThis.setTimeout;
    this.clearTimeoutFn = options.clearTimeout ?? globalThis.clearTimeout;
    this.setIntervalFn = options.setInterval ?? globalThis.setInterval;
    this.clearIntervalFn = options.clearInterval ?? globalThis.clearInterval;
    this.now = options.now ?? Date.now;
    this.currentStatus = {
      state: this.accessToken === null ? "disabled" : "stopped",
      reconnectAttempt: 0,
      lastError: null,
    };
    if (options.onStatus !== undefined) this.statusListeners.add(options.onStatus);
  }

  get status(): TransportStatus {
    return this.currentStatus;
  }

  onStatus(listener: TransportStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => this.statusListeners.delete(listener);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    if (this.accessToken === null) {
      this.publish({ state: "disabled", reconnectAttempt: 0, lastError: null });
      return;
    }
    this.publish({ state: "connecting", reconnectAttempt: 0, lastError: null });
    this.connect();
  }

  updateAccessToken(accessToken: string | null): void {
    if (this.accessToken === accessToken) return;
    this.accessToken = accessToken;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    this.detachSocket(true);
    if (!this.running) {
      this.publish({
        state: accessToken === null ? "disabled" : "stopped",
        reconnectAttempt: 0,
        lastError: null,
      });
      return;
    }
    if (this.paused) {
      this.publish({ state: "paused", reconnectAttempt: 0, lastError: null });
      return;
    }
    if (accessToken === null) {
      this.publish({ state: "disabled", reconnectAttempt: 0, lastError: null });
      return;
    }
    this.publish({ state: "connecting", reconnectAttempt: 0, lastError: null });
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.paused = false;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    this.detachSocket(true);
    this.publish({ state: "stopped", reconnectAttempt: this.reconnectAttempt, lastError: null });
  }

  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.clearReconnectTimer();
    this.clearHeartbeatTimer();
    this.detachSocket(true);
    this.publish({ state: "paused", reconnectAttempt: this.reconnectAttempt, lastError: null });
  }

  resume(): void {
    if (!this.running || !this.paused) return;
    this.paused = false;
    this.publish({ state: "connecting", reconnectAttempt: this.reconnectAttempt, lastError: null });
    this.connect();
  }

  async reconcile(): Promise<void> {
    if (!this.running || this.paused) return;
    await this.readInbox();
  }

  private publish(status: TransportStatus): void {
    this.currentStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private connect(): void {
    if (!this.running || this.paused || this.socket !== null || this.accessToken === null) return;
    let socket: NotificationSocket;
    try {
      socket = this.options.openSocket(this.options.socketUrl, this.accessToken);
    } catch {
      this.handleSocketFailure("SOCKET_CREATE_FAILED");
      return;
    }
    this.socket = socket;
    this.lastActivityAt = this.now();
    this.socketUnsubscribers = [
      socket.onOpen(() => this.handleSocketOpen(socket)),
      socket.onMessage((payload) => this.handleMessage(socket, payload)),
      socket.onClose(() => this.handleSocketClose(socket)),
      socket.onError((code) => this.handleSocketFailure(code)),
      ...(socket.onPong === undefined ? [] : [socket.onPong(() => this.markActivity(socket))]),
    ];
  }

  private handleSocketOpen(socket: NotificationSocket): void {
    if (socket !== this.socket || !this.running || this.paused) return;
    this.reconnectAttempt = 0;
    this.lastActivityAt = this.now();
    this.clearReconnectTimer();
    this.publish({ state: "connected", reconnectAttempt: 0, lastError: null });
    this.startHeartbeat(socket);
    void this.readInbox();
  }

  private handleMessage(socket: NotificationSocket, payload: string): void {
    if (socket !== this.socket || !this.running || this.paused) return;
    this.markActivity(socket);
    const event = parseSafePushEvent(payload);
    if (event === null) return;
    if (this.seenEvents.has(event.eventId)) return;
    void this.readInbox().then((items) => this.deliverFromEvent(event, items));
  }

  private deliverFromEvent(event: SafePushEvent, items: readonly DurableNotification[]): void {
    if (!this.running || this.paused) return;
    this.seenEvents.add(event.eventId);
    const item = items.find((candidate) => candidate.id === event.notificationId);
    if (item === undefined) return;
    this.deliver(item, event);
  }

  private lastInbox: readonly DurableNotification[] = [];

  private async readInbox(): Promise<readonly DurableNotification[]> {
    if (this.inboxRead !== null) return this.inboxRead;
    this.inboxRead = (async () => {
      try {
        const items = await this.options.fetchInbox();
        this.lastInbox = items;
        for (const item of items) {
          if (item.readAt === null) this.deliver(item, null);
        }
        return items;
      } catch {
        this.publish({
          state: this.currentStatus.state,
          reconnectAttempt: this.reconnectAttempt,
          lastError: "INBOX_READ_FAILED",
        });
        return this.lastInbox;
      } finally {
        this.inboxRead = null;
      }
    })();
    return this.inboxRead;
  }

  private deliver(item: DurableNotification, event: SafePushEvent | null): void {
    if (item.readAt !== null || this.seenNotifications.has(item.id)) return;
    this.seenNotifications.add(item.id);
    try {
      this.options.showNotification({
        notificationId: item.id,
        eventId: event?.eventId ?? null,
        title: item.title,
        body: item.body,
        bugId: item.bugId ?? event?.bugId ?? null,
      });
    } catch {
      // A native notification failure must never tear down the authenticated
      // transport or cause duplicate attempts on the next reconciliation.
    }
  }

  private markActivity(socket: NotificationSocket): void {
    if (socket === this.socket) this.lastActivityAt = this.now();
  }

  private startHeartbeat(socket: NotificationSocket): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = this.setIntervalFn(() => {
      if (socket !== this.socket || !this.running || this.paused) return;
      if (this.now() - this.lastActivityAt > HEARTBEAT_TIMEOUT_MS) {
        this.handleSocketFailure("HEARTBEAT_TIMEOUT");
        return;
      }
      try {
        if (socket.ping !== undefined) socket.ping();
        else socket.send(JSON.stringify({ type: "ping" }));
      } catch {
        this.handleSocketFailure("HEARTBEAT_SEND_FAILED");
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private handleSocketClose(socket: NotificationSocket): void {
    if (socket !== this.socket) return;
    this.detachSocket(false);
    if (this.running && !this.paused) this.scheduleReconnect("SOCKET_CLOSED");
  }

  private handleSocketFailure(code: string): void {
    if (this.socket !== null) this.detachSocket(true);
    if (this.running && !this.paused) this.scheduleReconnect(code);
  }

  private scheduleReconnect(code: string): void {
    if (this.reconnectTimer !== null || !this.running || this.paused) return;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** Math.min(this.reconnectAttempt, 6));
    this.reconnectAttempt += 1;
    this.publish({
      state: "reconnecting",
      reconnectAttempt: this.reconnectAttempt,
      lastError: code,
    });
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    this.clearTimeoutFn(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer === null) return;
    this.clearIntervalFn(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private detachSocket(close: boolean): void {
    const socket = this.socket;
    this.socket = null;
    const unsubscribers = this.socketUnsubscribers;
    this.socketUnsubscribers = [];
    for (const unsubscribe of unsubscribers) unsubscribe();
    this.clearHeartbeatTimer();
    if (close && socket !== null) {
      try {
        socket.close();
      } catch {
        // Cleanup is best effort and must not prevent explicit quit.
      }
    }
  }
}
