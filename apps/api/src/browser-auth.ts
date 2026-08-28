import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { MOBILE_API_CONTENT_TYPE } from "./mobile-bugs.js";

export const BROWSER_LOGIN_PATH = "/api/v1/auth/login" as const;
export const BROWSER_ME_PATH = "/api/v1/auth/me" as const;
export const BROWSER_LOGOUT_PATH = "/api/v1/auth/logout" as const;
export const BROWSER_SESSION_COOKIE = "qa_hub_browser_session" as const;
export const BROWSER_CSRF_HEADER = "x-csrf-token" as const;
export const BROWSER_SESSION_TTL_MS = 8 * 60 * 60 * 1_000;

const AUTHENTICATION_FAILED = { code: "AUTHENTICATION_FAILED" } as const;
const UNAUTHENTICATED = { code: "UNAUTHENTICATED" } as const;

export interface BrowserAuthPrincipal {
  readonly accountId: string;
  readonly userId: string;
  readonly actorId: string;
  readonly email: string;
  readonly displayName: string;
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
}

function parsePasswordlessLoginBody(body: unknown): {
  readonly name: string;
  readonly client: "web" | "android";
} {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("login body is invalid");
  }
  const value = body as LoginBody;
  const name = requireText(value.name, "name", 100);
  if (value.client !== "web" && value.client !== "android") {
    throw new TypeError("client is invalid");
  }
  return { name, client: value.client };
}

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

export function browserSessionTokenFromCookieHeader(
  value: string | readonly string[] | undefined,
): string | undefined {
  const raw = typeof value === "string" ? value : undefined;
  if (raw === undefined) return undefined;
  for (const item of raw.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 1) continue;
    const name = item.slice(0, separator).trim();
    if (name !== BROWSER_SESSION_COOKIE) continue;
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

function cookieHeader(token: string, secure: boolean, maxAgeSeconds: number): string {
  return [
    `${BROWSER_SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function clearCookieHeader(secure: boolean): string {
  return [
    `${BROWSER_SESSION_COOKIE}=`,
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
} {
  return {
    accountId: principal.accountId,
    userId: principal.userId,
    email: principal.email,
    displayName: principal.displayName,
    csrfToken,
  };
}

function requestNow(options: BrowserAuthOptions): Date {
  return options.now?.() ?? new Date();
}

function sessionTtl(options: BrowserAuthOptions): number {
  const ttl = options.sessionTtlMs ?? BROWSER_SESSION_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > 24 * 60 * 60 * 1_000) {
    throw new Error("browser session TTL must be between one minute and 24 hours");
  }
  return ttl;
}

export function browserAuthSession(request: FastifyRequest): string | undefined {
  const token = browserSessionTokenFromCookieHeader(request.headers.cookie);
  if (token === undefined) return undefined;
  return token;
}

export async function authenticateBrowserRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: BrowserAuthOptions,
): Promise<BrowserAuthPrincipal | undefined> {
  const token = browserAuthSession(request);
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
    }>;
    readonly resolveBrowserSession: (input: ResolveBrowserSessionInput) => Promise<{
      readonly accountId: string;
      readonly userId: string;
      readonly email: string;
      readonly displayName: string;
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
  }): BrowserAuthPrincipal => {
    const resolved = {
      accountId: principal.accountId,
      userId: principal.userId,
      actorId: principal.userId,
      email: principal.email,
      displayName: principal.displayName,
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
  const secureCookie =
    options.secureCookie ?? options.webOrigins.every((origin) => origin.startsWith("https://"));
  const ttl = sessionTtl(options);
  const ttlSeconds = Math.floor(ttl / 1_000);

  app.post(BROWSER_LOGIN_PATH, async (request, reply) => {
    try {
      const passwordless = options.passwordlessLogin;
      const passwordlessBody = parsePasswordlessLoginBody(request.body);
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
      const principal = await passwordless(passwordlessBody.name, issuedAt.toISOString()).then(
        (identity) => options.store.createBrowserSession({ ...session, userId: identity.userId }),
      );
      if (principal === null) return writeJson(reply, 401, AUTHENTICATION_FAILED);
      if (passwordlessBody?.client === "android") {
        return writeJson(reply, 200, {
          ...principalResponse(principal, browserCsrfToken(token, options.sessionSecret)),
          accessToken: token,
          expiresAt: expiresAt.toISOString(),
        });
      }
      return reply
        .header("set-cookie", cookieHeader(token, secureCookie, ttlSeconds))
        .code(200)
        .header("content-type", MOBILE_API_CONTENT_TYPE)
        .send(principalResponse(principal, browserCsrfToken(token, options.sessionSecret)));
    } catch (error: unknown) {
      if (error instanceof TypeError) return writeJson(reply, 400, { code: "INVALID_REQUEST" });
      throw error;
    }
  });

  app.get(BROWSER_ME_PATH, async (request, reply) => {
    const principal = await authenticateBrowserRequest(request, reply, options);
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
    const principal = await authenticateBrowserRequest(request, reply, options);
    if (principal === undefined) return reply.sent ? reply : writeJson(reply, 401, UNAUTHENTICATED);
    const token = (request as BrowserAuthRequest).browserSessionToken;
    if (token === undefined) return writeJson(reply, 401, UNAUTHENTICATED);
    await options.store.revokeBrowserSession({
      tokenDigest: digestBrowserSessionToken(token),
      now: requestNow(options).toISOString(),
      reason: "logout",
    });
    return reply
      .header("set-cookie", clearCookieHeader(secureCookie))
      .code(200)
      .header("content-type", MOBILE_API_CONTENT_TYPE)
      .send({ ok: true });
  });
}

export function getBrowserPrincipal(request: FastifyRequest): BrowserAuthPrincipal | undefined {
  return (request as BrowserAuthRequest).browserPrincipal;
}
