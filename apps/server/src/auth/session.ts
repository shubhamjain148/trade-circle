import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { MemberRow } from "../domain.js";
import type { Storage } from "../storage/index.js";
import { hashToken, randomToken } from "./vault.js";

export const SESSION_COOKIE = "watcher_session";

export interface SessionEnv {
  Variables: { member: MemberRow };
}

export interface SessionOptions {
  ttlMs: number;
  /** Set Secure on the cookie; off for plain-http local dev. */
  secure?: boolean;
}

/** Mints a session, stores only its hash, and sets the cookie. */
export async function issueSession(
  c: Context,
  storage: Storage,
  memberId: string,
  opts: SessionOptions,
): Promise<void> {
  const token = randomToken();
  const now = new Date();
  await storage.createSession({
    tokenHash: hashToken(token),
    memberId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + opts.ttlMs).toISOString(),
  });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: opts.secure ?? false,
    path: "/",
    maxAge: Math.floor(opts.ttlMs / 1000),
  });
}

export async function clearSession(c: Context, storage: Storage): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await storage.deleteSession(hashToken(token));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export async function currentMember(
  c: Context,
  storage: Storage,
): Promise<MemberRow | undefined> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return undefined;
  const session = await storage.getSession(
    hashToken(token),
    new Date().toISOString(),
  );
  if (!session) return undefined;
  return storage.getMember(session.memberId);
}

/** 401s anything without a live session; downstream handlers read c.get("member"). */
export function requireSession(storage: Storage): MiddlewareHandler<SessionEnv> {
  return async (c, next) => {
    const member = await currentMember(c, storage);
    if (!member) return c.json({ error: "unauthorized" }, 401);
    c.set("member", member);
    await next();
  };
}
