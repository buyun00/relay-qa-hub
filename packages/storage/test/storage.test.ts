import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  StorageConfigurationError,
  defineStorageConfig,
  parseStorageEnvironment,
  summarizeStorageHealth,
  type StorageHealthCheck,
  type StorageHealthStatus,
} from "../src/index.ts";

test("storage config derives isolated paths without touching the filesystem", () => {
  const sourceRoot = resolve(".");
  const dataRoot = resolve("..", "qa-hub-test-data");
  const config = defineStorageConfig({ sourceRoot, dataRoot });

  assert.equal(config.driver, "sqlite");
  assert.equal(config.dataRoot, dataRoot);
  assert.equal(config.databaseFile, resolve(dataRoot, "db", "qa-hub.sqlite"));
  assert.equal(config.evidenceRoot, resolve(dataRoot, "evidence"));
  assert.equal(config.quarantineRoot, resolve(dataRoot, "quarantine"));
  assert.equal(config.busyTimeoutMs, 5_000);
  assert.equal(config.wal, true);
  assert.equal(Object.isFrozen(config), true);
});

test("storage config rejects relative and source-overlapping data roots", () => {
  assert.throws(
    () => defineStorageConfig({ dataRoot: "relative-data" }),
    StorageConfigurationError,
  );

  const sourceRoot = resolve(".");
  assert.throws(
    () =>
      defineStorageConfig({
        sourceRoot,
        dataRoot: resolve(sourceRoot, ".data"),
      }),
    /must not contain one another/,
  );
});

test("environment parsing requires WAL and validates numeric bounds", () => {
  const dataRoot = resolve("..", "qa-hub-test-data");
  assert.equal(
    parseStorageEnvironment({
      QA_HUB_DATA_ROOT: dataRoot,
      QA_HUB_SQLITE_BUSY_TIMEOUT_MS: "2500",
    }).busyTimeoutMs,
    2_500,
  );

  assert.throws(() => parseStorageEnvironment({}), /QA_HUB_DATA_ROOT is required/);
  assert.throws(
    () =>
      parseStorageEnvironment({
        QA_HUB_DATA_ROOT: dataRoot,
        QA_HUB_SQLITE_WAL: "false",
      }),
    /WAL is required/,
  );
});

test("health summary fails closed and preserves worst dependency state", () => {
  const now = new Date("2026-08-24T09:00:00.000Z");
  const mutableEvidenceCheck: {
    dependency: string;
    status: StorageHealthStatus;
    checkedAt: string;
    latencyMs: number;
    detail: string;
  } = {
    dependency: "evidence",
    status: "degraded",
    checkedAt: now.toISOString(),
    latencyMs: 5,
    detail: "capacity warning",
  };
  const checks: readonly StorageHealthCheck[] = [
    {
      dependency: "database",
      status: "healthy",
      checkedAt: now.toISOString(),
      latencyMs: 2,
    },
    mutableEvidenceCheck,
  ];

  const degraded = summarizeStorageHealth(checks, now);
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.checkedAt, now.toISOString());
  assert.equal(Object.isFrozen(degraded.checks), true);
  assert.equal(Object.isFrozen(degraded.checks[1]), true);

  mutableEvidenceCheck.status = "healthy";
  mutableEvidenceCheck.detail = "mutated after snapshot";
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.checks[1]?.status, "degraded");
  assert.equal(degraded.checks[1]?.detail, "capacity warning");

  assert.equal(summarizeStorageHealth([], now).status, "unhealthy");
  assert.equal(
    summarizeStorageHealth(
      [
        ...checks,
        {
          dependency: "quarantine",
          status: "unhealthy",
          checkedAt: now.toISOString(),
          latencyMs: 1,
        },
      ],
      now,
    ).status,
    "unhealthy",
  );
});
