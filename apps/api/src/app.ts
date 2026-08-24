import Fastify, { type FastifyInstance } from "fastify";

import { API_SERVICE_NAME, API_VERSION, DEVELOPMENT_BUILD_SHA, resolveBuildSha } from "./config.js";

export const LIVE_HEALTH_PATH = "/api/v1/health/live" as const;

export interface LiveHealth {
  readonly status: "ok";
  readonly service: typeof API_SERVICE_NAME;
  readonly version: string;
  readonly buildSha: string;
  readonly time: string;
}

export interface CreateApiAppOptions {
  readonly version?: string;
  readonly buildSha?: string;
  readonly now?: () => Date;
  readonly logger?: boolean;
}

const liveHealthResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "service", "version", "buildSha", "time"],
  properties: {
    status: { const: "ok" },
    service: { const: API_SERVICE_NAME },
    version: { type: "string", minLength: 1, maxLength: 100 },
    buildSha: { type: "string", pattern: "^(dev|[0-9a-f]{40})$" },
    time: { type: "string", format: "date-time" },
  },
} as const;

export function createLiveHealth(
  options: Pick<CreateApiAppOptions, "version" | "buildSha" | "now"> = {},
): LiveHealth {
  const version = options.version ?? API_VERSION;
  if (version.length === 0 || version.length > 100) {
    throw new Error("API version must contain from 1 through 100 characters");
  }

  return {
    status: "ok",
    service: API_SERVICE_NAME,
    version,
    buildSha: resolveBuildSha(options.buildSha ?? DEVELOPMENT_BUILD_SHA),
    time: (options.now ?? (() => new Date()))().toISOString(),
  };
}

export function createApiApp(options: CreateApiAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });

  app.get(
    LIVE_HEALTH_PATH,
    {
      schema: {
        response: {
          200: liveHealthResponseSchema,
        },
      },
    },
    async (): Promise<LiveHealth> => createLiveHealth(options),
  );

  return app;
}
