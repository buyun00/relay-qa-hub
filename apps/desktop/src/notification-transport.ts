const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const MAX_PUSH_BYTES = 16 * 1024;
export const MAX_INBOX_ITEMS = 100;
export const MAX_INBOX_BYTES = 256 * 1024;
export const MAX_SUMMARY_LENGTH = 300;
// One complete server Inbox snapshot is capped at 10,000 notifications.
export const MAX_SEEN_NOTIFICATIONS = 10_000;
// Windows retains at most 20 notifications per app in Notification Center.
export const MAX_PENDING_NOTIFICATIONS = 20;
const MAX_SEEN_EVENTS = 512;
export const MAX_PENDING_EVENTS = 512;
export const HEARTBEAT_INTERVAL_MS = 25_000;
export const HEARTBEAT_TIMEOUT_MS = 75_000;
export const MAX_RECONNECT_DELAY_MS = 60_000;
export const INBOX_RETRY_BASE_DELAY_MS = 1_000;
export const MAX_INBOX_RETRY_DELAY_MS = 60_000;

export interface SafePushEvent {
  readonly type: "notification.hint";
  readonly notificationId: string;
  readonly eventId: string;
  readonly summary: string;
  readonly bugId: string | null;
}

export interface DurableNotification {
  readonly id: string;
  readonly projectId: string;
  readonly userId: string;
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
  readonly projectId: string;
  readonly userId: string;
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

export interface InboxReconciliation {
  readonly generation: number;
  readonly notificationIds: readonly string[];
  readonly unreadNotificationIds: readonly string[];
  readonly locallyAcknowledgedNotificationIds: readonly string[];
  readonly presentationAttemptedNotificationIds: readonly string[];
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
export type NotificationSink = (notification: DesktopNotification) => boolean | Promise<boolean>;
export type NotificationBatchPreparer = (
  notifications: readonly DesktopNotification[],
) => boolean | Promise<boolean>;
export type TransportStatusListener = (status: TransportStatus) => void;
export type InboxReconciliationListener = (result: InboxReconciliation) => void;

export interface NotificationTransportOptions {
  readonly socketUrl: URL;
  readonly accessToken: string | null;
  readonly openSocket: NotificationSocketFactory;
  readonly fetchInbox: InboxFetcher;
  readonly prepareNotifications?: NotificationBatchPreparer;
  readonly showNotification: NotificationSink;
  /**
   * Maximum number of Bug presentations that may remain pending right now.
   * The desktop main process uses this to reserve the shared Windows per-app
   * notification budget for update, packaging, and retained scoped toasts.
   */
  readonly maxPendingNotifications?: () => number;
  readonly seenNotificationIds?: readonly string[];
  readonly onStatus?: TransportStatusListener;
  readonly onReconcile?: InboxReconciliationListener;
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

function newestNotificationFirst(a: DurableNotification, b: DurableNotification): number {
  const createdAtDifference = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (createdAtDifference !== 0) return createdAtDifference;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

function desktopNotification(
  item: DurableNotification,
  event: SafePushEvent | null,
): DesktopNotification {
  return {
    notificationId: item.id,
    eventId: event?.eventId ?? null,
    projectId: item.projectId,
    userId: item.userId,
    title: item.title,
    body: item.body,
    bugId: item.bugId ?? event?.bugId ?? null,
  };
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
    const projectId = requiredUuid(itemValue["projectId"]);
    const userId = requiredUuid(itemValue["userId"]);
    const type = boundedText(itemValue["type"], 120);
    const title = boundedText(itemValue["title"], MAX_SUMMARY_LENGTH);
    const body = itemValue["body"] === undefined ? type : boundedText(itemValue["body"], 500);
    const bugId = nullableUuid(itemValue["bugId"]);
    const createdAt = boundedText(itemValue["createdAt"], 100);
    const readAt = itemValue["readAt"] === null ? null : boundedText(itemValue["readAt"], 100);
    const version = itemValue["version"];
    if (
      id === null ||
      projectId === null ||
      userId === null ||
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
      projectId,
      userId,
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
  private readonly pendingNotifications = new Set<string>();
  private readonly attemptedNotifications = new Set<string>();
  private readonly pendingEvents = new Set<string>();
  private readonly seenEvents = new BoundedSet(MAX_SEEN_EVENTS);
  private readonly statusListeners = new Set<TransportStatusListener>();
  private readonly options: NotificationTransportOptions;
  private accessToken: string | null;
  private socket: NotificationSocket | null = null;
  private socketUnsubscribers: readonly (() => void)[] = [];
  private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private inboxRetryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private inboxRetryDelayMs: number | null = null;
  private heartbeatTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private reconnectAttempt = 0;
  private lastActivityAt = 0;
  private running = false;
  private paused = false;
  private inboxRead: Promise<{
    readonly generation: number;
    readonly items: readonly DurableNotification[];
    readonly succeeded: boolean;
  }> | null = null;
  private inboxGeneration = 0;
  private reconciliationFailureAttempt = 0;
  private presentationFailureAttempt = 0;
  private overflowReconciliationPending = false;
  private coalescedReconciliationPending = false;
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

  acknowledge(notificationId: string): boolean {
    const normalized = requiredUuid(notificationId);
    if (normalized === null) return false;
    this.seenNotifications.add(normalized);
    this.pendingNotifications.delete(normalized);
    this.attemptedNotifications.delete(normalized);
    if (this.lastInboxHasRetryableNotification()) this.requestReconcile();
    return true;
  }

  requestReconcile(): boolean {
    if (!this.running || this.paused || this.accessToken === null) return false;
    if (this.inboxRead !== null) {
      this.coalescedReconciliationPending = true;
      return true;
    }
    return this.scheduleInboxReconciliation(0);
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
    this.clearInboxRetryTimer();
    this.resetInboxRetryState();
    this.lastInbox = [];
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
    this.clearInboxRetryTimer();
    this.resetInboxRetryState();
    this.lastInbox = [];
    this.clearHeartbeatTimer();
    this.detachSocket(true);
    this.publish({ state: "stopped", reconnectAttempt: this.reconnectAttempt, lastError: null });
  }

  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.clearReconnectTimer();
    this.clearInboxRetryTimer();
    this.resetInboxRetryState();
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
    if (!this.running || this.paused || this.accessToken === null) return;
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
    if (this.seenEvents.has(event.eventId) || this.pendingEvents.has(event.eventId)) return;
    if (this.pendingEvents.size >= MAX_PENDING_EVENTS) {
      // The overflow hint itself is untrusted and is not claimed. Once every
      // accepted post-hint read drains, force a fresh durable Inbox generation
      // so a row committed after those reads cannot starve indefinitely.
      this.overflowReconciliationPending = true;
      return;
    }
    this.pendingEvents.add(event.eventId);
    const minimumGeneration = this.inboxGeneration + 1;
    void this.deliverFromEvent(event, minimumGeneration).finally(() => {
      this.pendingEvents.delete(event.eventId);
      if (this.pendingEvents.size === 0 && this.overflowReconciliationPending) {
        this.overflowReconciliationPending = false;
        this.scheduleInboxReconciliation(0);
      }
    });
  }

  private async deliverFromEvent(event: SafePushEvent, minimumGeneration: number): Promise<void> {
    // A hint may arrive while socket-open reconciliation is still returning its
    // pre-commit snapshot. Require a read started after this hint before deciding
    // that its durable Inbox row is absent.
    const { items, succeeded } = await this.readInboxAfter(minimumGeneration, event);
    if (!this.running || this.paused) return;
    if (!succeeded) return;
    const item = items.find((candidate) => candidate.id === event.notificationId);
    if (item === undefined) return;
    if (item.readAt !== null || this.seenNotifications.has(item.id)) {
      this.seenEvents.add(event.eventId);
      return;
    }
    // This post-hint generation already attempted the unread item with its
    // matching event. The sink completion claims the event only on success.
  }

  private lastInbox: readonly DurableNotification[] = [];

  private async readInboxAfter(
    minimumGeneration: number,
    event: SafePushEvent,
  ): Promise<{
    readonly generation: number;
    readonly items: readonly DurableNotification[];
    readonly succeeded: boolean;
  }> {
    for (;;) {
      const result = await this.readInbox(event);
      if (result.generation >= minimumGeneration || !this.running || this.paused) return result;
    }
  }

  private async readInbox(event: SafePushEvent | null = null): Promise<{
    readonly generation: number;
    readonly items: readonly DurableNotification[];
    readonly succeeded: boolean;
  }> {
    if (this.inboxRead !== null) return this.inboxRead;
    this.clearInboxRetryTimer();
    const generation = ++this.inboxGeneration;
    this.inboxRead = (async () => {
      try {
        const items = await this.options.fetchInbox();
        if (!this.running || this.paused) return { generation, items, succeeded: true };
        this.lastInbox = items;
        const unreadNotificationIds = items
          .filter((item) => item.readAt === null)
          .map((item) => item.id);
        const locallyAcknowledgedNotificationIds = unreadNotificationIds.filter((id) => {
          if (!this.seenNotifications.has(id)) return false;
          // Keep acknowledgements from the complete current snapshot ahead of
          // stale entries when the bounded process-local set rolls over.
          this.seenNotifications.add(id);
          return true;
        });
        const currentUnread = new Set(unreadNotificationIds);
        for (const notificationId of this.attemptedNotifications) {
          if (!currentUnread.has(notificationId) || this.seenNotifications.has(notificationId)) {
            this.attemptedNotifications.delete(notificationId);
          }
        }
        const newestItems = [...items].sort(newestNotificationFirst);
        const matchingItem =
          event === null
            ? undefined
            : newestItems.find((candidate) => candidate.id === event.notificationId);
        const remainingItems =
          matchingItem === undefined
            ? newestItems
            : newestItems.filter((candidate) => candidate !== matchingItem);
        const deliveryItems = [
          ...(matchingItem === undefined ? [] : [matchingItem]),
          ...remainingItems.filter((candidate) => !this.attemptedNotifications.has(candidate.id)),
          ...remainingItems.filter((candidate) => this.attemptedNotifications.has(candidate.id)),
        ];
        const pendingLimit = this.currentPendingNotificationLimit();
        const availablePresentations = Math.max(0, pendingLimit - this.pendingNotifications.size);
        const candidates: {
          readonly item: DurableNotification;
          readonly event: SafePushEvent | null;
          readonly notification: DesktopNotification;
        }[] = [];
        for (const item of deliveryItems) {
          if (candidates.length >= availablePresentations) break;
          if (!this.canDeliver(item)) continue;
          const matchingEvent = event?.notificationId === item.id ? event : null;
          candidates.push({
            item,
            event: matchingEvent,
            notification: desktopNotification(item, matchingEvent),
          });
        }
        const prepared =
          candidates.length === 0 || this.options.prepareNotifications === undefined
            ? true
            : await this.options.prepareNotifications(
                candidates.map((candidate) => candidate.notification),
              );
        const presentationAttemptedNotificationIds: string[] = [];
        if (prepared) {
          this.reconciliationFailureAttempt = 0;
          for (const candidate of candidates) {
            if (this.deliver(candidate.item, candidate.event)) {
              presentationAttemptedNotificationIds.push(candidate.item.id);
            }
          }
        } else {
          this.scheduleFailedInboxReconciliation("reconciliation");
        }
        try {
          this.options.onReconcile?.({
            generation,
            notificationIds: items.map((item) => item.id),
            unreadNotificationIds,
            locallyAcknowledgedNotificationIds,
            presentationAttemptedNotificationIds,
          });
        } catch {
          // Observability must not turn a successful Inbox read into a retry.
        }
        return { generation, items, succeeded: true };
      } catch {
        if (this.running && !this.paused) {
          this.publish({
            state: this.currentStatus.state,
            reconnectAttempt: this.reconnectAttempt,
            lastError: "INBOX_READ_FAILED",
          });
          this.scheduleFailedInboxReconciliation("reconciliation");
        }
        return { generation, items: this.lastInbox, succeeded: false };
      } finally {
        this.inboxRead = null;
        if (this.coalescedReconciliationPending) {
          this.coalescedReconciliationPending = false;
          this.scheduleInboxReconciliation(0);
        }
      }
    })();
    return this.inboxRead;
  }

  private canDeliver(item: DurableNotification): boolean {
    return (
      this.running &&
      !this.paused &&
      item.readAt === null &&
      !this.seenNotifications.has(item.id) &&
      !this.pendingNotifications.has(item.id) &&
      this.pendingNotifications.size < this.currentPendingNotificationLimit()
    );
  }

  private currentPendingNotificationLimit(): number {
    if (this.options.maxPendingNotifications === undefined) return MAX_PENDING_NOTIFICATIONS;
    try {
      const value = this.options.maxPendingNotifications();
      if (!Number.isSafeInteger(value) || value < 0) return 0;
      return Math.min(value, MAX_PENDING_NOTIFICATIONS);
    } catch {
      return 0;
    }
  }

  private deliver(item: DurableNotification, event: SafePushEvent | null): boolean {
    if (!this.canDeliver(item)) return false;
    this.pendingNotifications.add(item.id);
    const notification = desktopNotification(item, event);
    let delivery: boolean | Promise<boolean>;
    try {
      delivery = this.options.showNotification(notification);
    } catch {
      this.pendingNotifications.delete(item.id);
      this.attemptedNotifications.add(item.id);
      this.scheduleFailedInboxReconciliation("presentation");
      return false;
    }
    this.attemptedNotifications.add(item.id);
    let acknowledged = false;
    void Promise.resolve(delivery)
      .then((result) => {
        acknowledged = result;
        if (result) {
          this.seenNotifications.add(item.id);
          if (event !== null) this.seenEvents.add(event.eventId);
        }
      })
      .catch(() => {
        // The unread item remains eligible for a later reconciliation.
      })
      .finally(() => {
        this.pendingNotifications.delete(item.id);
        if (!this.lastInboxHasRetryableNotification()) return;
        if (acknowledged) {
          this.presentationFailureAttempt = 0;
          this.scheduleInboxReconciliation(0);
        } else {
          this.scheduleFailedInboxReconciliation("presentation");
        }
      });
    return true;
  }

  private lastInboxHasRetryableNotification(): boolean {
    return this.lastInbox.some(
      (item) =>
        item.readAt === null &&
        !this.seenNotifications.has(item.id) &&
        !this.pendingNotifications.has(item.id),
    );
  }

  private scheduleFailedInboxReconciliation(kind: "reconciliation" | "presentation"): void {
    const attempt =
      kind === "reconciliation"
        ? this.reconciliationFailureAttempt
        : this.presentationFailureAttempt;
    const delay = Math.min(
      MAX_INBOX_RETRY_DELAY_MS,
      INBOX_RETRY_BASE_DELAY_MS * 2 ** Math.min(attempt, 6),
    );
    if (!this.scheduleInboxReconciliation(delay)) return;
    if (kind === "reconciliation") this.reconciliationFailureAttempt += 1;
    else this.presentationFailureAttempt += 1;
  }

  private scheduleInboxReconciliation(delayMs: number): boolean {
    if (!this.running || this.paused || this.accessToken === null) return false;
    if (this.inboxRetryTimer !== null) {
      if (this.inboxRetryDelayMs !== null && this.inboxRetryDelayMs <= delayMs) return false;
      this.clearInboxRetryTimer();
    }
    this.inboxRetryDelayMs = delayMs;
    this.inboxRetryTimer = this.setTimeoutFn(() => {
      this.inboxRetryTimer = null;
      this.inboxRetryDelayMs = null;
      if (!this.running || this.paused || this.accessToken === null) return;
      void this.readInbox();
    }, delayMs);
    return true;
  }

  private clearInboxRetryTimer(): void {
    if (this.inboxRetryTimer === null) return;
    this.clearTimeoutFn(this.inboxRetryTimer);
    this.inboxRetryTimer = null;
    this.inboxRetryDelayMs = null;
  }

  private resetInboxRetryState(): void {
    this.reconciliationFailureAttempt = 0;
    this.presentationFailureAttempt = 0;
    this.overflowReconciliationPending = false;
    this.coalescedReconciliationPending = false;
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
