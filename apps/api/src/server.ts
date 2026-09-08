import type { FastifyInstance } from "fastify";

import { createApiApp, type CreateApiAppOptions } from "./app.js";
import { DEFAULT_API_HOST, DEFAULT_API_PORT } from "./config.js";

export interface ApiListenOptions {
  readonly host?: string;
  readonly port?: number;
}

export interface ApiServer {
  readonly app: FastifyInstance;
  readonly start: (options?: ApiListenOptions) => Promise<string>;
  readonly stop: () => Promise<void>;
}

async function closeInOrder(
  operations: readonly (() => Promise<unknown> | undefined)[],
): Promise<void> {
  const errors: unknown[] = [];
  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      if (!errors.includes(error)) errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "API resource cleanup failed");
}

/** The component database and its in-flight work must finish before the worker. */
export async function closeApiRuntime(resources: {
  server: ApiServer | undefined;
  componentsRuntime: { close(): Promise<void> } | undefined;
  worker: { close(): Promise<void> };
  relayPump?: { stop(): Promise<void> } | undefined;
  backupRunner?: { stop(): Promise<void> } | undefined;
}): Promise<void> {
  await closeInOrder([
    () => (resources.server ? resources.server.stop() : resources.componentsRuntime?.close()),
    () => resources.relayPump?.stop(),
    () => resources.backupRunner?.stop(),
    () => resources.worker.close(),
  ]);
}

export function createApiServer(appOptions: CreateApiAppOptions = {}): ApiServer {
  const app = createApiApp(appOptions);
  let address: string | undefined;
  let startPromise: Promise<string> | undefined;
  let stopPromise: Promise<void> | undefined;
  let componentsClosePromise: Promise<void> | undefined;
  let stopped = false;

  const closeComponents = (): Promise<void> => {
    componentsClosePromise ??= Promise.resolve().then(() =>
      appOptions.projectComponentsRuntime?.close(),
    );
    return componentsClosePromise;
  };
  // Direct app.close() callers also release ownership, without closing twice
  // when stop() or failed startup has already drained the runtime.
  app.addHook("onClose", async () => {
    stopped = true;
    await closeComponents();
  });
  // Fastify stops accepting requests and drains handlers before onClose drains
  // component work. The fallback also covers failure before that hook runs.
  const closeApp = (): Promise<void> => closeInOrder([() => app.close(), closeComponents]);

  const start = async (options: ApiListenOptions = {}): Promise<string> => {
    if (stopped) {
      throw new Error("A stopped API server cannot be started again");
    }
    if (address !== undefined) {
      return address;
    }
    if (startPromise !== undefined) {
      return startPromise;
    }

    startPromise = (async () => {
      try {
        const listeningAddress = await app.listen({
          host: options.host ?? DEFAULT_API_HOST,
          port: options.port ?? DEFAULT_API_PORT,
        });
        if (stopped) throw new Error("API server stopped during startup");
        // onReady runs before binding and must never dispatch queued work.
        appOptions.projectComponentsRuntime?.start();
        address = listeningAddress;
        return address;
      } catch (error: unknown) {
        stopped = true;
        try {
          await closeApp();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "API startup and cleanup failed");
        }
        throw error;
      }
    })();
    return startPromise;
  };

  const stop = async (): Promise<void> => {
    if (stopPromise !== undefined) {
      return stopPromise;
    }

    stopped = true;
    stopPromise = (async () => {
      if (startPromise !== undefined) {
        try {
          await startPromise;
        } catch {
          // A failed listen has no open socket, but Fastify still needs closing.
        }
      }
      await closeApp();
      address = undefined;
    })();

    return stopPromise;
  };

  return { app, start, stop };
}
