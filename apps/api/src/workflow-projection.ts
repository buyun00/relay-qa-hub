import type { FastifyInstance } from "fastify";
import { getBrowserPrincipal } from "./browser-auth.js";
import { MOBILE_API_CONTENT_TYPE, MOBILE_API_MEDIA_TYPE } from "./mobile-bugs.js";

export interface WorkflowProjectionQuery {
  readonly actorId: string;
  readonly bugId: string;
  readonly cursor?: string;
  readonly limitPerCollection?: number;
}
export interface WorkflowProjectionStore {
  readonly getPage: (query: WorkflowProjectionQuery) => Promise<unknown>;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

export function parseWorkflowProjectionQuery(
  bugId: unknown,
  query: unknown,
): Omit<WorkflowProjectionQuery, "actorId"> {
  if (
    typeof bugId !== "string" ||
    !UUID.test(bugId) ||
    !query ||
    typeof query !== "object" ||
    Array.isArray(query)
  )
    throw new TypeError("Invalid workflow query");
  const value = query as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "cursor" && key !== "limitPerCollection"))
    throw new TypeError("Invalid workflow query");
  const cursor = value["cursor"];
  const rawLimit = value["limitPerCollection"];
  if (cursor !== undefined && (typeof cursor !== "string" || !cursor.length || cursor.length > 500))
    throw new TypeError("Invalid workflow cursor");
  if (
    rawLimit !== undefined &&
    (typeof rawLimit !== "string" || !/^[1-9][0-9]{0,2}$/u.test(rawLimit) || Number(rawLimit) > 100)
  )
    throw new TypeError("Invalid workflow page limit");
  return {
    bugId,
    ...(cursor === undefined ? {} : { cursor: cursor as string }),
    ...(rawLimit === undefined ? {} : { limitPerCollection: Number(rawLimit) }),
  };
}

/** This new endpoint only has a vendor representation; it does not repurpose human-workflow. */
function acceptsVendor(accept: string | undefined): boolean {
  if (accept === undefined) return true;
  let exact: number | undefined,
    applicationWildcard: number | undefined,
    wildcard: number | undefined;
  for (const part of accept.split(",")) {
    const [media, ...parameters] = part.trim().toLowerCase().split(";");
    const parameter = parameters.map((x) => x.trim()).find((x) => x.startsWith("q="));
    const q =
      parameter === undefined
        ? 1
        : /^q=(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/u.test(parameter)
          ? Number(parameter.slice(2))
          : 0;
    if (media === MOBILE_API_MEDIA_TYPE) exact = Math.max(exact ?? 0, q);
    if (media === "application/*") applicationWildcard = Math.max(applicationWildcard ?? 0, q);
    if (media === "*/*") wildcard = Math.max(wildcard ?? 0, q);
  }
  return (exact ?? applicationWildcard ?? wildcard ?? 0) > 0;
}

/** Called explicitly by the integrator after BrowserAuth and ProjectRequestContext registration. */
export function registerWorkflowProjectionRoutes(
  app: FastifyInstance,
  store: WorkflowProjectionStore,
): void {
  app.get("/api/v1/bugs/:bugId/workflow", async (request, reply) => {
    const principal = getBrowserPrincipal(request);
    if (!principal) return reply.code(401).send({ code: "UNAUTHENTICATED" });
    if (!acceptsVendor(request.headers.accept))
      return reply.code(406).send({ code: "NOT_ACCEPTABLE" });
    let query: Omit<WorkflowProjectionQuery, "actorId">;
    try {
      query = parseWorkflowProjectionQuery(
        (request.params as { bugId?: unknown }).bugId,
        request.query,
      );
    } catch {
      return reply.code(400).send({ code: "INVALID_REQUEST" });
    }
    try {
      const result = await store.getPage({ ...query, actorId: principal.actorId });
      return reply.header("cache-control", "no-store").type(MOBILE_API_CONTENT_TYPE).send(result);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      const statuses: Record<string, number> = {
        INVALID_REQUEST: 400,
        FORBIDDEN: 403,
        NOT_FOUND: 404,
        RATE_LIMITED: 429,
      };
      // Frozen manifest omits 400 although its cursor behavior requires rejection.
      // Preserve that documented inconsistency; never echo DB details or private signing material.
      if (typeof code === "string" && statuses[code])
        return reply.code(statuses[code]!).send({ code });
      return reply.code(500).send({ code: "INTERNAL_ERROR" });
    }
  });
}
