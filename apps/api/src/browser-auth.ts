import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { MOBILE_API_CONTENT_TYPE } from "./mobile-bugs.js";

export const BROWSER_LOGIN_PATH = "/api/v1/auth/login" as const;
export const BROWSER_ME_PATH = "/api/v1/auth/me" as const;
export const BROWSER_LOGOUT_PATH = "/api/v1/auth/logout" as const;
export const BROWSER_SESSION_COOKIE = "qa_hub_browser_session" as const;
export const BROWSER_CSRF_HEADER = "x-csrf-token" as const;
// Browser sessions are permanent user identities. They remain valid until the
// user explicitly signs out or the backend disables the account/user. Keep a
// finite cookie lifetime only because browsers require one; storage resolution
// does not use expires_at as an authorization boundary.
export const BROWSER_SESSION_TTL_MS = 2_147_483_647 * 1_000;

const AUTHENTICATION_FAILED = { code: "AUTHENTICATION_FAILED" } as const;
const UNAUTHENTICATED = { code: "UNAUTHENTICATED" } as const;

export interface BrowserAuthPrincipal {
  readonly accountId: string;
  readonly userId: string;
  readonly actorId: string;
  readonly email: string;
  readonly displayName: string;
  readonly projectId?: string;
  readonly isGm?: boolean;
}

export interface EnsureBrowserAdminInput {
  readonly accountId: string;
  readonly userId: string;
  readonly actorId: string;
  readonly email: string;
  readonly password: string;
  readonly now: string;
}

export interface LoginBrowserSessionInput {
  readonly accountId: string;
  readonly email: string;
  readonly password: string;
  readonly sessionId: string;
  readonly tokenDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface CreateBrowserSessionInput {
  readonly accountId: string;
  readonly userId: string;
  readonly projectId?: string;
  readonly isGm?: boolean;
  readonly sessionId: string;
  readonly tokenDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface ResolveBrowserSessionInput {
  readonly tokenDigest: string;
  readonly now: string;
}

export interface RevokeBrowserSessionInput {
  readonly tokenDigest: string;
  readonly now: string;
  readonly reason: string;
}

export interface BrowserAuthStore {
  readonly ensureBrowserAdmin: (input: EnsureBrowserAdminInput) => Promise<void>;
  readonly loginBrowserSession: (
    input: LoginBrowserSessionInput,
  ) => Promise<BrowserAuthPrincipal | null>;
  readonly createBrowserSession: (
    input: CreateBrowserSessionInput,
  ) => Promise<BrowserAuthPrincipal | null>;
  readonly resolveBrowserSession: (
    input: ResolveBrowserSessionInput,
  ) => Promise<BrowserAuthPrincipal | null>;
  readonly revokeBrowserSession: (input: RevokeBrowserSessionInput) => Promise<boolean>;
}

export interface BrowserAuthOptions {
  readonly store: BrowserAuthStore;
  readonly accountId: string;
  readonly userId: string;
  readonly actorId: string;
  readonly adminEmail: string;
  readonly passwordlessLogin: (name: string, now: string) => Promise<{ readonly userId: string }>;
  readonly projectLogin?: (
    name: string,
    projectId: string,
    now: string,
  ) => Promise<{ readonly userId: string; readonly projectId: string }>;
  readonly projectCodeLogin?: (
    name: string,
    projectName: string,
    joinCode: string,
    now: string,
    clientKey: string,
  ) => Promise<{ readonly userId: string; readonly projectId: string }>;
  readonly legacyProjectId?: string;
  readonly cookieName?: string;
  readonly gm?: { readonly userId: string; readonly password: string };
  readonly sessionSecret: string;
  readonly webOrigins: readonly string[];
  readonly now?: () => Date;
  readonly sessionTtlMs?: number;
  readonly secureCookie?: boolean;
}

interface BrowserAuthRequest extends FastifyRequest {
  browserPrincipal?: BrowserAuthPrincipal;
  browserSessionToken?: string;
}

interface LoginBody {
  readonly name?: unknown;
  readonly client?: unknown;
  readonly projectId?: unknown;
  readonly projectName?: unknown;
  readonly code?: unknown;
}

function parseProjectCodeLoginBody(body: unknown): {
  readonly name: string;
  readonly projectName: string;
  readonly code: string;
  readonly client: "web" | "android";
} {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    throw new TypeError("login body is invalid");
  const value = body as LoginBody;
  for (const key of Object.keys(value))
    if (!new Set(["name", "projectName", "code", "client"]).has(key))
      throw new TypeError(`unexpected property: ${key}`);
  const name = requireText(value.name, "name", 100);
  const projectName = requireText(value.projectName, "projectName", 200);
  const code = requireText(value.code, "code", 4);
  if (!/^\d{4}$/u.test(code)) throw new TypeError("code is invalid");
  if (value.client !== "web" && value.client !== "android")
    throw new TypeError("client is invalid");
  return { name, projectName, code, client: value.client };
}

function parsePasswordlessLoginBody(body: unknown): {
  readonly name: string;
  readonly client: "web" | "android";
  readonly projectId?: string;
} {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("login body is invalid");
  }
  const value = body as LoginBody;
  const name = requireText(value.name, "name", 100);
  if (value.client !== "web" && value.client !== "android") {
    throw new TypeError("client is invalid");
  }
  return {
    name,
    client: value.client,
    ...(value.projectId === undefined
      ? {}
      : { projectId: requireText(value.projectId, "projectId", 100) }),
  };
}

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

export function browserSessionTokenFromCookieHeader(
  value: string | readonly string[] | undefined,
  cookieName: string = BROWSER_SESSION_COOKIE,
): string | undefined {
  const raw = typeof value === "string" ? value : undefined;
  if (raw === undefined) return undefined;
  for (const item of raw.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 1) continue;
    const name = item.slice(0, separator).trim();
    if (name !== cookieName) continue;
    const token = item.slice(separator + 1).trim();
    if (/^[A-Za-z0-9_-]{43}$/u.test(token)) return token;
    return undefined;
  }
  return undefined;
}

export function digestBrowserSessionToken(token: string): string {
  return createHash("sha256").update(token, "ascii").digest("hex");
}

export function browserCsrfToken(sessionToken: string, sessionSecret: string): string {
  return createHmac("sha256", sessionSecret).update(sessionToken, "ascii").digest("hex");
}

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function originMatches(request: FastifyRequest, expectedOrigins: readonly string[]): boolean {
  const origin = request.headers.origin;
  return typeof origin === "string" && expectedOrigins.includes(origin);
}

function requestNeedsCsrf(request: FastifyRequest): boolean {
  return request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";
}

function cookieHeader(token: string, secure: boolean, maxAgeSeconds: number, name: string): string {
  return [
    `${name}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function clearCookieHeader(secure: boolean, name: string): string {
  return [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function writeJson(reply: FastifyReply, status: number, value: unknown): FastifyReply {
  return reply.code(status).header("content-type", MOBILE_API_CONTENT_TYPE).send(value);
}

function principalResponse(
  principal: BrowserAuthPrincipal,
  csrfToken: string,
): {
  readonly accountId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly csrfToken: string;
  readonly projectId?: string;
  readonly isGm: boolean;
} {
  return {
    accountId: principal.accountId,
    userId: principal.userId,
    email: principal.email,
    displayName: principal.displayName,
    csrfToken,
    ...(principal.projectId === undefined ? {} : { projectId: principal.projectId }),
    isGm: principal.isGm === true,
  };
}

function requestNow(options: BrowserAuthOptions): Date {
  return options.now?.() ?? new Date();
}

function sessionTtl(options: BrowserAuthOptions): number {
  const ttl = options.sessionTtlMs ?? BROWSER_SESSION_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > BROWSER_SESSION_TTL_MS) {
    throw new Error("browser session TTL must fit the permanent cookie lifetime");
  }
  return ttl;
}

export function browserAuthSession(
  request: FastifyRequest,
  cookieName: string = BROWSER_SESSION_COOKIE,
): string | undefined {
  const token = browserSessionTokenFromCookieHeader(request.headers.cookie, cookieName);
  if (token === undefined) return undefined;
  return token;
}

export async function authenticateBrowserRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: BrowserAuthOptions,
): Promise<BrowserAuthPrincipal | undefined> {
  const token = browserAuthSession(request, options.cookieName);
  if (token === undefined) return undefined;
  const now = requestNow(options);
  const principal = await options.store.resolveBrowserSession({
    tokenDigest: digestBrowserSessionToken(token),
    now: now.toISOString(),
  });
  if (principal === null) {
    await writeJson(reply, 401, UNAUTHENTICATED);
    return undefined;
  }
  if (requestNeedsCsrf(request) && !originMatches(request, options.webOrigins)) {
    await writeJson(reply, 403, { code: "CSRF_ORIGIN_INVALID" });
    return undefined;
  }
  if (requestNeedsCsrf(request)) {
    const supplied = request.headers[BROWSER_CSRF_HEADER];
    const expected = browserCsrfToken(token, options.sessionSecret);
    if (!equalSecret(typeof supplied === "string" ? supplied : "", expected)) {
      await writeJson(reply, 403, { code: "CSRF_TOKEN_INVALID" });
      return undefined;
    }
  }
  const browserRequest = request as BrowserAuthRequest;
  browserRequest.browserPrincipal = principal;
  browserRequest.browserSessionToken = token;
  return principal;
}

export async function authenticateBrowserBearerRequest(
  request: FastifyRequest,
  options: BrowserAuthOptions,
): Promise<BrowserAuthPrincipal | undefined> {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return undefined;
  }
  const token = authorization.slice("Bearer ".length);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return undefined;
  const principal = await options.store.resolveBrowserSession({
    tokenDigest: digestBrowserSessionToken(token),
    now: requestNow(options).toISOString(),
  });
  if (principal === null) return undefined;
  const browserRequest = request as BrowserAuthRequest;
  browserRequest.browserPrincipal = principal;
  browserRequest.browserSessionToken = token;
  return principal;
}

export function createSqliteBrowserAuthStore(options: {
  readonly worker: {
    readonly ensureBrowserAdmin: (input: {
      readonly accountId: string;
      readonly userId: string;
      readonly password: string;
      readonly now: string;
    }) => Promise<unknown>;
    readonly loginBrowserSession: (input: {
      readonly accountId: string;
      readonly email: string;
      readonly password: string;
      readonly sessionId: string;
      readonly tokenDigest: string;
      readonly issuedAt: string;
      readonly expiresAt: string;
    }) => Promise<{
      readonly accountId: string;
      readonly userId: string;
      readonly email: string;
      readonly displayName: string;
    }>;
    readonly createBrowserSession: (input: CreateBrowserSessionInput) => Promise<{
      readonly accountId: string;
      readonly userId: string;
      readonly email: string;
      readonly displayName: string;
      readonly projectId?: string;
      readonly isGm?: boolean;
    }>;
    readonly resolveBrowserSession: (input: ResolveBrowserSessionInput) => Promise<{
      readonly accountId: string;
      readonly userId: string;
      readonly email: string;
      readonly displayName: string;
      readonly projectId?: string;
      readonly isGm?: boolean;
    } | null>;
    readonly revokeBrowserSession: (input: RevokeBrowserSessionInput) => Promise<boolean>;
  };
  readonly canonicalizePrincipal?: (principal: BrowserAuthPrincipal) => BrowserAuthPrincipal;
}): BrowserAuthStore {
  const withActor = (principal: {
    readonly accountId: string;
    readonly userId: string;
    readonly email: string;
    readonly displayName: string;
    readonly projectId?: string;
    readonly isGm?: boolean;
  }): BrowserAuthPrincipal => {
    const resolved = {
      accountId: principal.accountId,
      userId: principal.userId,
      actorId: principal.userId,
      email: principal.email,
      displayName: principal.displayName,
      ...(principal.projectId === undefined ? {} : { projectId: principal.projectId }),
      ...(principal.isGm ? { isGm: true } : {}),
    };
    return options.canonicalizePrincipal?.(resolved) ?? resolved;
  };
  return {
    ensureBrowserAdmin: async (input) => {
      await options.worker.ensureBrowserAdmin({
        accountId: input.accountId,
        userId: input.userId,
        password: input.password,
        now: input.now,
      });
    },
    loginBrowserSession: async (input) => {
      try {
        return withActor(await options.worker.loginBrowserSession(input));
      } catch (error: unknown) {
        if ((error as { readonly code?: unknown })?.code === "AUTHENTICATION_FAILED") {
          return null;
        }
        throw error;
      }
    },
    createBrowserSession: async (input) => {
      try {
        return withActor(await options.worker.createBrowserSession(input));
      } catch (error: unknown) {
        if ((error as { readonly code?: unknown })?.code === "AUTHENTICATION_FAILED") {
          return null;
        }
        throw error;
      }
    },
    resolveBrowserSession: async (input) => {
      const principal = await options.worker.resolveBrowserSession(input);
      return principal === null ? null : withActor(principal);
    },
    revokeBrowserSession: (input) => options.worker.revokeBrowserSession(input),
  };
}

export function registerBrowserAuthRoutes(app: FastifyInstance, options: BrowserAuthOptions): void {
  const cookieName = options.cookieName ?? BROWSER_SESSION_COOKIE;
  if (!/^[A-Za-z0-9_-]{1,100}$/u.test(cookieName))
    throw new Error("browser cookie name is invalid");
  const secureCookie =
    options.secureCookie ?? options.webOrigins.every((origin) => origin.startsWith("https://"));
  const ttl = sessionTtl(options);
  const ttlSeconds = Math.floor(ttl / 1_000);

  app.post(BROWSER_LOGIN_PATH, async (request, reply) => {
    try {
      const passwordless = options.passwordlessLogin;
      const passwordlessBody = options.projectCodeLogin
        ? parseProjectCodeLoginBody(request.body)
        : parsePasswordlessLoginBody(request.body);
      if (passwordlessBody.client === "web" && !originMatches(request, options.webOrigins)) {
        return writeJson(reply, 403, { code: "CSRF_ORIGIN_INVALID" });
      }
      const issuedAt = requestNow(options);
      const expiresAt = new Date(issuedAt.getTime() + ttl);
      const token = randomBytes(32).toString("base64url");
      const session = {
        accountId: options.accountId,
        sessionId: randomUUID(),
        tokenDigest: digestBrowserSessionToken(token),
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
      const identity =
        options.projectCodeLogin && "projectName" in passwordlessBody
          ? await options.projectCodeLogin(
              passwordlessBody.name,
              passwordlessBody.projectName,
              passwordlessBody.code,
              issuedAt.toISOString(),
              request.ip,
            )
          : await (async () => {
              const legacy = passwordlessBody as ReturnType<typeof parsePasswordlessLoginBody>;
              const projectId = legacy.projectId ?? options.legacyProjectId;
              if (options.projectLogin && !projectId)
                throw Object.assign(new Error("请选择项目"), { code: "PROJECT_REQUIRED" });
              return options.projectLogin && projectId
                ? options.projectLogin(legacy.name, projectId, issuedAt.toISOString())
                : passwordless(legacy.name, issuedAt.toISOString());
            })();
      if (options.gm?.userId === identity.userId)
        return writeJson(reply, 403, { code: "GM_PASSWORD_REQUIRED" });
      const principal = await options.store.createBrowserSession({
        ...session,
        userId: identity.userId,
        ...("projectId" in identity && typeof identity.projectId === "string"
          ? { projectId: identity.projectId }
          : {}),
      });
      if (principal === null) return writeJson(reply, 401, AUTHENTICATION_FAILED);
      if (passwordlessBody?.client === "android") {
        return writeJson(reply, 200, {
          ...principalResponse(principal, browserCsrfToken(token, options.sessionSecret)),
          accessToken: token,
          expiresAt: expiresAt.toISOString(),
        });
      }
      return reply
        .header("set-cookie", cookieHeader(token, secureCookie, ttlSeconds, cookieName))
        .code(200)
        .header("content-type", MOBILE_API_CONTENT_TYPE)
        .send(principalResponse(principal, browserCsrfToken(token, options.sessionSecret)));
    } catch (error: unknown) {
      const code = (error as { readonly code?: string })?.code;
      if (
        ["PROJECT_MEMBERSHIP_DISABLED", "PROJECT_NOT_ACCESSIBLE", "GM_PASSWORD_REQUIRED"].includes(
          code ?? "",
        )
      )
        return writeJson(reply, 403, { code });
      if (code === "RATE_LIMITED") {
        const seconds = Number((error as { retryAfterSeconds?: unknown }).retryAfterSeconds);
        return reply
          .header(
            "retry-after",
            Number.isSafeInteger(seconds) && seconds > 0 ? String(seconds) : "30",
          )
          .code(429)
          .header("content-type", MOBILE_API_CONTENT_TYPE)
          .send({ code, message: "尝试次数过多，请稍后重试" });
      }
      if (code === "AUTHENTICATION_FAILED") return writeJson(reply, 401, AUTHENTICATION_FAILED);
      if (code === "NOT_FOUND") return writeJson(reply, 404, { code });
      if ((error as { readonly code?: unknown })?.code === "SQLITE_MOBILE_SCOPE_CONFLICT") {
        return writeJson(reply, 401, AUTHENTICATION_FAILED);
      }
      if (error instanceof TypeError) return writeJson(reply, 400, { code: "INVALID_REQUEST" });
      throw error;
    }
  });

  app.post("/api/v1/auth/gm/login", async (request, reply) => {
    const value = request.body as {
      password?: unknown;
      client?: unknown;
      projectId?: unknown;
    } | null;
    if (
      !value ||
      (value.client !== "web" && value.client !== "android") ||
      typeof value.password !== "string"
    )
      return writeJson(reply, 400, { code: "INVALID_REQUEST" });
    if (
      value.projectId !== undefined &&
      (typeof value.projectId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.projectId))
    )
      return writeJson(reply, 400, { code: "INVALID_REQUEST" });
    if (value.client === "web" && !originMatches(request, options.webOrigins))
      return writeJson(reply, 403, { code: "CSRF_ORIGIN_INVALID" });
    if (!options.gm || !equalSecret(value.password, options.gm.password))
      return writeJson(reply, 401, AUTHENTICATION_FAILED);
    const token = randomBytes(32).toString("base64url");
    const issuedAt = requestNow(options);
    const expiresAt = new Date(issuedAt.getTime() + ttl);
    const principal = await options.store.createBrowserSession({
      accountId: options.accountId,
      userId: options.gm.userId,
      isGm: true,
      ...(typeof value.projectId === "string" ? { projectId: value.projectId } : {}),
      sessionId: randomUUID(),
      tokenDigest: digestBrowserSessionToken(token),
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    if (!principal) return writeJson(reply, 401, AUTHENTICATION_FAILED);
    const result = principalResponse(principal, browserCsrfToken(token, options.sessionSecret));
    if (value.client === "android")
      return writeJson(reply, 200, {
        ...result,
        accessToken: token,
        expiresAt: expiresAt.toISOString(),
      });
    return reply
      .header("set-cookie", cookieHeader(token, secureCookie, ttlSeconds, cookieName))
      .send(result);
  });

  app.get(BROWSER_ME_PATH, async (request, reply) => {
    const principal =
      (await authenticateBrowserBearerRequest(request, options)) ??
      (await authenticateBrowserRequest(request, reply, options));
    if (principal === undefined) return reply.sent ? reply : writeJson(reply, 401, UNAUTHENTICATED);
    const token = (request as BrowserAuthRequest).browserSessionToken;
    if (token === undefined) return writeJson(reply, 401, UNAUTHENTICATED);
    return writeJson(
      reply,
      200,
      principalResponse(principal, browserCsrfToken(token, options.sessionSecret)),
    );
  });

  app.post(BROWSER_LOGOUT_PATH, async (request, reply) => {
    const principal =
      (await authenticateBrowserBearerRequest(request, options)) ??
      (await authenticateBrowserRequest(request, reply, options));
    if (principal === undefined) return reply.sent ? reply : writeJson(reply, 401, UNAUTHENTICATED);
    const token = (request as BrowserAuthRequest).browserSessionToken;
    if (token === undefined) return writeJson(reply, 401, UNAUTHENTICATED);
    await options.store.revokeBrowserSession({
      tokenDigest: digestBrowserSessionToken(token),
      now: requestNow(options).toISOString(),
      reason: "logout",
    });
    return reply
      .header("set-cookie", clearCookieHeader(secureCookie, cookieName))
      .code(200)
      .header("content-type", MOBILE_API_CONTENT_TYPE)
      .send({ ok: true });
  });
}

export function getBrowserPrincipal(request: FastifyRequest): BrowserAuthPrincipal | undefined {
  return (request as BrowserAuthRequest).browserPrincipal;
}
