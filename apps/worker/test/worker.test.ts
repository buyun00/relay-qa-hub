import assert from "node:assert/strict";
import test from "node:test";

import {
  PollingWorker,
  WorkerConfigurationError,
  parseWorkerConfig,
  type WorkerWait,
} from "../src/index.ts";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

function waitUntilAborted(entered: Deferred<void>): WorkerWait {
  return async (_delayMs, signal) => {
    entered.resolve();
    if (signal.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  };
}

test("worker config is independent and validates the polling boundary", () => {
  const config = parseWorkerConfig({
    QA_HUB_BUILD_SHA: "abc123",
    QA_HUB_WORKER_POLL_INTERVAL_MS: "250",
  });

  assert.deepEqual(config, {
    serviceName: "relay-qa-hub-worker",
    version: "0.1.0-debug",
    buildSha: "abc123",
    pollIntervalMs: 250,
  });
  assert.equal(Object.isFrozen(config), true);
  assert.equal("relay" in config, false);

  assert.throws(
    () => parseWorkerConfig({ QA_HUB_WORKER_POLL_INTERVAL_MS: "not-a-number" }),
    WorkerConfigurationError,
  );
  assert.throws(
    () => parseWorkerConfig({ QA_HUB_WORKER_POLL_INTERVAL_MS: "0" }),
    /between 25 and 600000/,
  );
});

test("worker polls immediately and exits gracefully through AbortSignal", async () => {
  const waitEntered = deferred<void>();
  let observedSignal: AbortSignal | undefined;
  const worker = new PollingWorker({
    config: parseWorkerConfig({ QA_HUB_WORKER_POLL_INTERVAL_MS: "25" }),
    poll({ signal }) {
      observedSignal = signal;
    },
    wait: waitUntilAborted(waitEntered),
  });

  worker.start();
  await waitEntered.promise;

  const running = worker.snapshot();
  assert.equal(running.lifecycle, "running");
  assert.equal(running.status, "healthy");
  assert.equal(running.live, true);
  assert.equal(running.ready, true);
  assert.equal(running.cyclesStarted, 1);
  assert.equal(running.cyclesSucceeded, 1);

  await worker.stop("unit_test");
  assert.equal(observedSignal?.aborted, true);

  const stopped = worker.snapshot();
  assert.equal(stopped.lifecycle, "stopped");
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.live, false);
  assert.equal(stopped.ready, false);
  assert.equal(stopped.stopReason, "unit_test");
  assert.notEqual(stopped.stoppedAt, null);
});

test("worker records a sanitized degraded snapshot and remains stoppable", async () => {
  const waitEntered = deferred<void>();
  const worker = new PollingWorker({
    config: parseWorkerConfig({ QA_HUB_WORKER_POLL_INTERVAL_MS: "25" }),
    poll() {
      throw new Error("credential-like detail must not enter health");
    },
    wait: waitUntilAborted(waitEntered),
  });

  worker.start();
  await waitEntered.promise;

  const degraded = worker.snapshot();
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.ready, false);
  assert.equal(degraded.cyclesFailed, 1);
  assert.equal(degraded.consecutiveFailures, 1);
  assert.equal(degraded.lastFailure?.name, "Error");
  assert.equal(JSON.stringify(degraded).includes("credential-like detail"), false);

  await worker.stop("unit_test");
});

test("an external abort stops an in-flight poll without requiring Relay", async () => {
  const pollEntered = deferred<void>();
  const external = new AbortController();
  const worker = new PollingWorker({
    config: parseWorkerConfig({ QA_HUB_WORKER_POLL_INTERVAL_MS: "25" }),
    async poll({ signal }) {
      pollEntered.resolve();
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    },
  });

  worker.start(external.signal);
  await pollEntered.promise;
  external.abort("test complete");
  await worker.whenStopped();

  const snapshot = worker.snapshot();
  assert.equal(snapshot.lifecycle, "stopped");
  assert.equal(snapshot.stopReason, "external_abort");
  assert.equal(snapshot.cyclesStarted, 1);
});
