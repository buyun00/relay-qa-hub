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

export function createApiServer(appOptions: CreateApiAppOptions = {}): ApiServer {
  const app = createApiApp(appOptions);
  let address: string | undefined;
  let startPromise: Promise<string> | undefined;
  let stopPromise: Promise<void> | undefined;
  let stopped = false;

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

    startPromise = app.listen({
      host: options.host ?? DEFAULT_API_HOST,
      port: options.port ?? DEFAULT_API_PORT,
    });

    try {
      address = await startPromise;
      return address;
    } catch (error: unknown) {
      startPromise = undefined;
      throw error;
    }
  };

  const stop = async (): Promise<void> => {
    if (stopPromise !== undefined) {
      return stopPromise;
    }

    stopPromise = (async () => {
      if (startPromise !== undefined) {
        try {
          await startPromise;
        } catch {
          // A failed listen has no open socket, but Fastify still needs closing.
        }
      }
      await app.close();
      stopped = true;
      address = undefined;
    })();

    return stopPromise;
  };

  return { app, start, stop };
}
