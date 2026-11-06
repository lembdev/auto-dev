import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { InstallationStore } from "../index/runtime-index.js";
import type { Clock } from "../ports/clock.js";

export const SESSION_COOKIE = "auto_dev_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
// Key in the `installation` table that holds the HMAC secret of session cookies; rotating it logs everyone out.
export const SESSION_SECRET_KEY = "session.secret";

// Routes that work without a session: the UI needs them to show the login screen and the liveness check.
export const PUBLIC_API_PATHS: readonly string[] = ["/api/health", "/api/login", "/api/session"];

export type AuthOptions = {
  // argon2 hash of the Installation password, read on every request because the wizard and the
  // Settings page change it while the server runs; undefined means nobody can log in yet.
  passwordHash: () => string | undefined;
  // Extra `Host` values accepted besides the built-in safe ones.
  allowedHosts: readonly string[];
};

// Sessions are stateless: the cookie carries its expiry and an HMAC over it with a secret kept in the
// index, so a session survives a restart and nothing is stored per login.
export class SessionCookies {
  private readonly _secret: Buffer;

  constructor(
    installation: InstallationStore,
    private readonly _clock: Clock,
  ) {
    const stored = installation.find(SESSION_SECRET_KEY);
    if (stored !== undefined) {
      this._secret = Buffer.from(stored, "base64url");
    } else {
      this._secret = randomBytes(32);
      installation.set(SESSION_SECRET_KEY, this._secret.toString("base64url"));
    }
  }

  issue(): { value: string; expiresAt: number } {
    const expiresAt = this._clock.now() + SESSION_TTL_MS;
    const nonce = randomBytes(8).toString("base64url");
    const payload = `${expiresAt}.${nonce}`;
    return { value: `${payload}.${this._sign(payload)}`, expiresAt };
  }

  verify(value: string | undefined): boolean {
    if (!value) return false;
    const parts = value.split(".");
    if (parts.length !== 3) return false;
    const [expires, nonce, signature] = parts as [string, string, string];
    const expected = this._sign(`${expires}.${nonce}`);
    if (expected.length !== signature.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return false;
    const expiresAt = Number(expires);
    return Number.isFinite(expiresAt) && expiresAt > this._clock.now();
  }

  private _sign(payload: string): string {
    return createHmac("sha256", this._secret).update(payload).digest("base64url");
  }
}

export const verifyPassword = async (hash: string | undefined, password: string): Promise<boolean> => {
  if (hash === undefined) return false;
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
};

export const hashPassword = (password: string): Promise<string> => argon2.hash(password);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// A `Host` is safe against DNS rebinding when it cannot be a public DNS name: an IP literal, `localhost`,
// a single-label LAN name or an mDNS `.local` name. Anything else must be listed explicitly.
export function isAllowedHost(header: string | undefined, allowed: readonly string[]): boolean {
  if (!header) return false;
  const host = hostnameOf(header);
  if (host === "") return false;
  if (allowed.some((entry) => hostnameOf(entry) === host)) return true;
  if (host.startsWith("[") && host.endsWith("]")) return true;
  if (IPV4.test(host)) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local")) return true;
  return !host.includes(".");
}

// Browsers always send `Origin` on a WebSocket handshake; it must point at an allowed host.
export function isAllowedOrigin(origin: string | undefined, allowed: readonly string[]): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return isAllowedHost(url.host, allowed);
}

// `host` or `host:port`, lower-cased; an IPv6 literal keeps its brackets.
const hostnameOf = (value: string): string => {
  const lower = value.trim().toLowerCase();
  if (lower.startsWith("[")) {
    const end = lower.indexOf("]");
    return end === -1 ? "" : lower.slice(0, end + 1);
  }
  const colon = lower.indexOf(":");
  return colon === -1 ? lower : lower.slice(0, colon);
};

export const hostCheck = (allowed: readonly string[]): MiddlewareHandler => async (c, next) => {
  if (!isAllowedHost(c.req.header("host"), allowed)) return c.json({ error: "forbidden host" }, 403);
  await next();
};

export type SessionCheckOptions = {
  // Extra routes that work without a session, decided per request (the wizard before a password exists).
  isPublic?: (c: Context) => boolean;
};

export const sessionCheck = (sessions: SessionCookies, allowedOrigins: readonly string[], options: SessionCheckOptions = {}): MiddlewareHandler => async (c, next) => {
  if (PUBLIC_API_PATHS.includes(c.req.path) || options.isPublic?.(c)) return next();
  if (c.req.header("upgrade")?.toLowerCase() === "websocket" && !isAllowedOrigin(c.req.header("origin"), allowedOrigins)) {
    return c.json({ error: "forbidden origin" }, 403);
  }
  if (!sessions.verify(getCookie(c, SESSION_COOKIE))) return c.json({ error: "unauthorized" }, 401);
  await next();
};

export const setSessionCookie = (c: Context, value: string): void => {
  // No `secure`: the UI is served over plain HTTP inside the LAN.
  setCookie(c, SESSION_COOKIE, value, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: SESSION_TTL_MS / 1000 });
};

export const clearSessionCookie = (c: Context): void => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
};

export const hasSession = (c: Context, sessions: SessionCookies): boolean => sessions.verify(getCookie(c, SESSION_COOKIE));
