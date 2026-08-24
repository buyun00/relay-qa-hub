import { setTimeout as waitForTimeout } from "node:timers/promises";

export const WORKER_VERSION = "0.1.0-debug";

export type WorkerEnvironment = Readonly<Record<string, string | undefined>>;

export interface WorkerConfig {
  readonly serviceName: "relay-qa-hub-worker";
  readonly version: string;
  readonly buildSha: string;
  readonly pollIntervalMs: number;
}

export class WorkerConfigurationError extends Error {
  readonly code = "WORKER_CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "WorkerConfigurationError";
  }
}

function parsePollInterval(value: string | undefined): number {
  if (value === undefined) {
    return 1_000;
  }

  if (!/^\d+$/.test(value)) {
    throw new WorkerConfigurationError("QA_HUB_WORKER_POLL_INTERVAL_MS must be an integer");
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 25 || parsed > 600_000) {
    throw new WorkerConfigurationError(
      "QA_HUB_WORKER_POLL_INTERVAL_MS must be between 25 and 600000",
    );
  }

  return parsed;
}

export function parseWorkerConfig(environment: WorkerEnvironment): WorkerConfig {
  const buildSha = environment.QA_HUB_BUILD_SHA?.trim() || "dev";
  if (buildSha.length > 128) {
    throw new WorkerConfigurationError("QA_HUB_BUILD_SHA must be at most 128 characters");
  }

  return Object.freeze({
    serviceName: "relay-qa-hub-worker",
    version: WORKER_VERSION,
    buildSha,
    pollIntervalMs: parsePollInterval(environment.QA_HUB_WORKER_POLL_INTERVAL_MS),
  });
}

export interface WorkerPollContext {
  readonly signal: AbortSignal;
  readonly cycle: number;
  readonly startedAt: string;
}

export type WorkerPollHandler = (context: WorkerPollContext) => void | Promise<void>;

export type WorkerWait = (delayMs: number, signal: AbortSignal) => Promise<void>;

export type WorkerLifecycleState = "created" | "running" | "stopping" | "stopped";

export type WorkerHealthStatus = "starting" | "healthy" | "degraded" | "stopping" | "stopped";

export interface WorkerFailureSnapshot {
  readonly name: string;
  readonly occurredAt: string;
}

export interface WorkerHealthSnapshot {
  readonly service: string;
  readonly version: string;
  readonly buildSha: string;
  readonly lifecycle: WorkerLifecycleState;
  readonly status: WorkerHealthStatus;
  readonly live: boolean;
  readonly ready: boolean;
  readonly startedAt: string | null;
  readonly stoppedAt: string | null;
  readonly stopReason: string | null;
  readonly pollInFlight: boolean;
  readonly cyclesStarted: number;
  readonly cyclesSucceeded: number;
  readonly cyclesFailed: number;
  readonly consecutiveFailures: number;
  readonly lastPollStartedAt: string | null;
  readonly lastPollSucceededAt: string | null;
  readonly lastFailure: WorkerFailureSnapshot | null;
}

export interface PollingWorkerOptions {
  readonly config: WorkerConfig;
  readonly poll: WorkerPollHandler;
  readonly wait?: WorkerWait;
  readonly now?: () => Date;
}

function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(name) ? name : "WorkerError";
}

async function abortableWait(delayMs: number, signal: AbortSignal): Promise<void> {
  await waitForTimeout(delayMs, undefined, { signal });
}

export class PollingWorker {
  readonly #config: WorkerConfig;
  readonly #poll: WorkerPollHandler;
  readonly #wait: WorkerWait;
  readonly #now: () => Date;

  #state: WorkerLifecycleState = "created";
  #controller: AbortController | null = null;
  #runPromise: Promise<void> | null = null;
  #removeExternalAbortListener: (() => void) | null = null;
  #startedAt: string | null = null;
  #stoppedAt: string | null = null;
  #stopReason: string | null = null;
  #pollInFlight = false;
  #cyclesStarted = 0;
  #cyclesSucceeded = 0;
  #cyclesFailed = 0;
  #consecutiveFailures = 0;
  #lastPollStartedAt: string | null = null;
  #lastPollSucceededAt: string | null = null;
  #lastFailure: WorkerFailureSnapshot | null = null;

  constructor(options: PollingWorkerOptions) {
    this.#config = options.config;
    this.#poll = options.poll;
    this.#wait = options.wait ?? abortableWait;
    this.#now = options.now ?? (() => new Date());
  }

  start(externalSignal?: AbortSignal): void {
    if (this.#state !== "created") {
      throw new Error("PollingWorker instances can only be started once");
    }

    const controller = new AbortController();
    this.#controller = controller;
    this.#state = "running";
    this.#startedAt = this.#timestamp();

    if (externalSignal !== undefined) {
      const stopFromExternalAbort = (): void => {
        this.#requestStop("external_abort", externalSignal.reason);
      };
      externalSignal.addEventListener("abort", stopFromExternalAbort, {
        once: true,
      });
      this.#removeExternalAbortListener = () => {
        externalSignal.removeEventListener("abort", stopFromExternalAbort);
      };
    }

    this.#runPromise = this.#runLoop(controller.signal).finally(() => {
      this.#removeExternalAbortListener?.();
      this.#removeExternalAbortListener = null;
      this.#pollInFlight = false;
      this.#state = "stopped";
      this.#stopReason ??= "completed";
      this.#stoppedAt = this.#timestamp();
    });

    if (externalSignal?.aborted === true) {
      this.#requestStop("external_abort", externalSignal.reason);
    }
  }

  async stop(reason = "requested"): Promise<void> {
    if (this.#state === "created") {
      this.#state = "stopped";
      this.#stopReason = reason;
      this.#stoppedAt = this.#timestamp();
      return;
    }

    if (this.#state !== "stopped") {
      this.#requestStop(reason);
    }
    await this.whenStopped();
  }

  async whenStopped(): Promise<void> {
    await (this.#runPromise ?? Promise.resolve());
  }

  snapshot(): WorkerHealthSnapshot {
    const live = this.#state === "running" || this.#state === "stopping";
    const ready =
      this.#state === "running" &&
      this.#lastPollSucceededAt !== null &&
      this.#consecutiveFailures === 0;

    let status: WorkerHealthStatus;
    if (this.#state === "created") {
      status = "starting";
    } else if (this.#state === "stopping") {
      status = "stopping";
    } else if (this.#state === "stopped") {
      status = "stopped";
    } else if (ready) {
      status = "healthy";
    } else if (this.#consecutiveFailures > 0) {
      status = "degraded";
    } else {
      status = "starting";
    }

    return Object.freeze({
      service: this.#config.serviceName,
      version: this.#config.version,
      buildSha: this.#config.buildSha,
      lifecycle: this.#state,
      status,
      live,
      ready,
      startedAt: this.#startedAt,
      stoppedAt: this.#stoppedAt,
      stopReason: this.#stopReason,
      pollInFlight: this.#pollInFlight,
      cyclesStarted: this.#cyclesStarted,
      cyclesSucceeded: this.#cyclesSucceeded,
      cyclesFailed: this.#cyclesFailed,
      consecutiveFailures: this.#consecutiveFailures,
      lastPollStartedAt: this.#lastPollStartedAt,
      lastPollSucceededAt: this.#lastPollSucceededAt,
      lastFailure: this.#lastFailure,
    });
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #requestStop(reason: string, abortReason?: unknown): void {
    if (this.#state !== "running" && this.#state !== "stopping") {
      return;
    }

    this.#state = "stopping";
    this.#stopReason ??= reason;
    this.#controller?.abort(abortReason ?? reason);
  }

  async #runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const cycle = this.#cyclesStarted + 1;
      const startedAt = this.#timestamp();
      this.#cyclesStarted = cycle;
      this.#lastPollStartedAt = startedAt;
      this.#pollInFlight = true;

      try {
        await this.#poll({ signal, cycle, startedAt });
        if (!signal.aborted) {
          this.#cyclesSucceeded += 1;
          this.#consecutiveFailures = 0;
          this.#lastPollSucceededAt = this.#timestamp();
          this.#lastFailure = null;
        }
      } catch (error: unknown) {
        if (!signal.aborted) {
          this.#cyclesFailed += 1;
          this.#consecutiveFailures += 1;
          this.#lastFailure = Object.freeze({
            name: safeErrorName(error),
            occurredAt: this.#timestamp(),
          });
        }
      } finally {
        this.#pollInFlight = false;
      }

      if (signal.aborted) {
        break;
      }

      try {
        await this.#wait(this.#config.pollIntervalMs, signal);
      } catch (error: unknown) {
        if (signal.aborted) {
          break;
        }

        this.#cyclesFailed += 1;
        this.#consecutiveFailures += 1;
        this.#lastFailure = Object.freeze({
          name: safeErrorName(error),
          occurredAt: this.#timestamp(),
        });
        this.#requestStop("poll_wait_failed", error);
      }
    }
  }
}

export interface WorkerLogRecord {
  readonly level: "info" | "error";
  readonly event: string;
  readonly service: string;
  readonly version: string;
  readonly buildSha: string;
  readonly reason?: string;
}

export interface WorkerLogger {
  write(record: WorkerLogRecord): void;
}

const jsonConsoleLogger: WorkerLogger = {
  write(record) {
    const line = JSON.stringify(record);
    if (record.level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
  },
};

export interface RunWorkerProcessOptions {
  readonly config?: WorkerConfig;
  readonly poll?: WorkerPollHandler;
  readonly signal?: AbortSignal;
  readonly logger?: WorkerLogger;
  readonly handleProcessSignals?: boolean;
}

const idlePoll: WorkerPollHandler = ({ signal }) => {
  signal.throwIfAborted();
};

export async function runWorkerProcess(
  options: RunWorkerProcessOptions = {},
): Promise<WorkerHealthSnapshot> {
  const config = options.config ?? parseWorkerConfig(process.env);
  const logger = options.logger ?? jsonConsoleLogger;
  const worker = new PollingWorker({
    config,
    poll: options.poll ?? idlePoll,
  });

  const handleSignals = options.handleProcessSignals ?? true;
  const stopForSignal = (signalName: "SIGINT" | "SIGTERM"): void => {
    void worker.stop(signalName);
  };

  const onSigint = (): void => {
    stopForSignal("SIGINT");
  };
  const onSigterm = (): void => {
    stopForSignal("SIGTERM");
  };

  if (handleSignals) {
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  }

  try {
    worker.start(options.signal);
    logger.write({
      level: "info",
      event: "worker.started",
      service: config.serviceName,
      version: config.version,
      buildSha: config.buildSha,
    });
    await worker.whenStopped();
    const snapshot = worker.snapshot();
    logger.write({
      level: "info",
      event: "worker.stopped",
      service: config.serviceName,
      version: config.version,
      buildSha: config.buildSha,
      reason: snapshot.stopReason ?? "unknown",
    });
    return snapshot;
  } finally {
    if (handleSignals) {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    }
  }
}
