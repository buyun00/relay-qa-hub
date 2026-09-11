import { promises as fs } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { JenkinsBuildService, PackagingError } from "./jenkins-builds.js";
import { COMPATIBILITY_TARGETS, type CompatibilityCheck } from "./jenkins-compatibility.js";
import { writeCompatibilityState } from "./build-compatibility-store.js";

export interface CompatibilityBatch {
  id: string;
  requestedAt: string;
  checks: CompatibilityCheck[];
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const finished = (b: CompatibilityBatch) =>
  b.checks.every((c) => c.state === "complete" || c.state === "error");
const code = (e: unknown) => (e instanceof PackagingError ? e.code : "CHECK_UNAVAILABLE");

/** Checks use Jenkins' Check-only choices. This service cannot select an App/Res build. */
export class BuildCompatibilityService {
  private current: CompatibilityBatch | null = null;
  private batches = new Map<string, CompatibilityBatch>();
  private ready: Promise<void>;
  private gate: Promise<unknown> = Promise.resolve();
  private writes: Promise<unknown> = Promise.resolve();
  private launches = new Map<string, Promise<void>>();
  private polls = new Map<string, Promise<CompatibilityBatch>>();
  constructor(
    private readonly jenkins: Pick<
      JenkinsBuildService,
      "startCompatibilityBatch" | "compatibilityProgress"
    >,
    private readonly root?: string,
  ) {
    this.ready = this.restore();
    void this.ready.catch(() => undefined);
  }
  private async restore() {
    if (!this.root) return;
    let b: CompatibilityBatch;
    try {
      b = JSON.parse(await fs.readFile(path.join(this.root, "current.json"), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new PackagingError("CHECK_STATE_UNAVAILABLE");
    }
    this.validateSaved(b);
    this.current = b;
    this.batches.set(b.id, b);
    // No acknowledgement is not proof of rejection. Never replay an interrupted POST.
    for (const c of b.checks)
      if (c.state === "submitting") {
        c.state = "error";
        c.errorCode = "JENKINS_SUBMISSION_UNKNOWN";
      }
    await this.persist(b);
  }
  private validateSaved(b: CompatibilityBatch) {
    if (
      !b ||
      !UUID.test(b.id) ||
      !Number.isFinite(Date.parse(b.requestedAt)) ||
      !Array.isArray(b.checks) ||
      b.checks.length !== 4 ||
      b.checks.some(
        (c, i) =>
          c.target?.id !== COMPATIBILITY_TARGETS[i]?.id ||
          c.target.platform !== COMPATIBILITY_TARGETS[i]?.platform ||
          c.target.configuration !== COMPATIBILITY_TARGETS[i]?.configuration ||
          !["pending", "submitting", "queued", "running", "complete", "error"].includes(c.state) ||
          (c.queueId !== null && (!Number.isSafeInteger(c.queueId) || c.queueId <= 0)) ||
          (c.buildNumber !== null && (!Number.isSafeInteger(c.buildNumber) || c.buildNumber <= 0)),
      )
    )
      throw new PackagingError("CHECK_STATE_UNAVAILABLE");
  }
  private persist(b: CompatibilityBatch): Promise<void> {
    const write = this.writes.then(async () => {
      if (!this.root) return;
      await fs.mkdir(path.join(this.root, "runs"), { recursive: true });
      await writeCompatibilityState(path.join(this.root, "runs", b.id + ".json"), b);
      if (this.current?.id === b.id)
        await writeCompatibilityState(path.join(this.root, "current.json"), b);
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
  private launch(b: CompatibilityBatch) {
    if (this.launches.has(b.id)) return;
    const work = (async () => {
      const pending = b.checks.filter((c) => c.state === "pending");
      if (!pending.length) return;
      for (const c of pending) c.state = "submitting";
      // Persist the whole intent before the single POST. Jenkins fans out all four
      // checks inside one executor, so they do not queue behind each other.
      await this.persist(b);
      try {
        const queueId = await this.jenkins.startCompatibilityBatch();
        for (const c of pending) {
          c.queueId = queueId;
          c.state = "queued";
          c.errorCode = null;
        }
      } catch (e) {
        for (const c of pending) {
          c.state = "error";
          c.errorCode = code(e);
        }
      }
      await this.persist(b);
    })().finally(() => this.launches.delete(b.id));
    this.launches.set(b.id, work);
    void work.catch(() => undefined); // Durable state remains unresolved if storage fails.
  }
  async start(id: string): Promise<CompatibilityBatch> {
    if (!UUID.test(id)) throw new PackagingError("INVALID_REQUEST", 400);
    const operation = this.gate.then(async () => {
      await this.ready;
      const existing = await this.load(id);
      if (existing) {
        this.launch(existing);
        return structuredClone(existing);
      }
      if (this.current && !finished(this.current)) {
        const current = await this.status(this.current.id);
        if (!finished(current)) return current; // Coalesce overlapping page entries.
      }
      const b: CompatibilityBatch = {
        id,
        requestedAt: new Date().toISOString(),
        checks: COMPATIBILITY_TARGETS.map((target) => ({
          target,
          state: "pending",
          queueId: null,
          buildNumber: null,
          checkedAt: null,
          reportUrl: null,
          errorCode: null,
          report: null,
        })),
      };
      this.current = b;
      this.batches.set(id, b);
      await this.persist(b);
      this.launch(b);
      return structuredClone(b);
    });
    this.gate = operation.catch(() => undefined);
    return operation;
  }
  private async load(id: string): Promise<CompatibilityBatch | null> {
    if (this.batches.has(id)) return this.batches.get(id)!;
    if (!this.root) return null;
    let b: CompatibilityBatch;
    try {
      b = JSON.parse(await fs.readFile(path.join(this.root, "runs", id + ".json"), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new PackagingError("CHECK_STATE_UNAVAILABLE");
    }
    this.validateSaved(b);
    this.batches.set(id, b);
    for (const c of b.checks)
      if (c.state === "submitting") {
        c.state = "error";
        c.errorCode = "JENKINS_SUBMISSION_UNKNOWN";
      }
    return b;
  }
  async status(id: string): Promise<CompatibilityBatch> {
    if (!UUID.test(id)) throw new PackagingError("INVALID_REQUEST", 400);
    await this.ready;
    const b = await this.load(id);
    if (!b) throw new PackagingError("CHECK_NOT_FOUND", 404);
    this.launch(b);
    const previous = this.polls.get(id);
    if (previous) return previous;
    const poll = (async () => {
      await Promise.all(
        b.checks.map(async (c) => {
          if (!["queued", "running"].includes(c.state)) return;
          try {
            Object.assign(c, await this.jenkins.compatibilityProgress(c));
          } catch (e) {
            c.errorCode = code(e);
            // A transient read outage does not invalidate an already queued check.
            if (
              ![
                "PACKAGING_UNAVAILABLE",
                "JENKINS_AUTH_FAILED",
                "CHECK_UNAVAILABLE",
                "CHECK_QUEUE_UNKNOWN",
              ].includes(c.errorCode)
            )
              c.state = "error";
            if (Date.now() - Date.parse(b.requestedAt) > 2 * 60 * 60_000) {
              c.state = "error";
              c.errorCode = "CHECK_TIMED_OUT";
            }
          }
        }),
      );
      await this.persist(b);
      return structuredClone(b);
    })().finally(() => this.polls.delete(id));
    this.polls.set(id, poll);
    return poll;
  }
  async close() {
    await this.gate.catch(() => undefined);
    await Promise.allSettled([...this.launches.values(), ...this.polls.values()]);
    await this.writes;
  }
}

export function registerCompatibilityRoutes(
  app: FastifyInstance,
  service: BuildCompatibilityService,
  actor: (request: FastifyRequest) => string | null,
) {
  app.addHook("onClose", () => service.close());
  app.route({
    method: ["GET", "POST"],
    url: "/api/v1/packaging/compatibility",
    handler: async (request, reply) => {
      if (!actor(request)) return reply.code(401).send({ code: "UNAUTHENTICATED" });
      try {
        const id =
          request.method === "POST"
            ? request.headers["idempotency-key"]
            : (request.query as Record<string, unknown>)["id"];
        if (
          typeof id !== "string" ||
          !UUID.test(id) ||
          (request.method === "POST" &&
            request.body !== undefined &&
            request.body !== null &&
            Object.keys(request.body as object).length !== 0)
        )
          throw new PackagingError("INVALID_REQUEST", 400);
        const result =
          request.method === "POST" ? await service.start(id) : await service.status(id);
        return reply
          .header("cache-control", "no-store")
          .code(request.method === "POST" ? 202 : 200)
          .send(result);
      } catch (e) {
        return reply.code(e instanceof PackagingError ? e.status : 503).send({ code: code(e) });
      }
    },
  });
}
