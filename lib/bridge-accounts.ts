/**
 * Many LinkedIn accounts for the Careervira Console bridge (X12).
 *
 * Each Console user (rep) connects their OWN LinkedIn account. One Linki account row per rep, tagged with the Console
 * user id (accounts.console_user_id, unique). Rules:
 *  - one person, one account (a user already linked to a different email is refused: already_linked)
 *  - one account, one person (an email already owned by another user is refused: account_taken)
 *  - the LinkedIn password is passed straight to the login routine and is never stored or logged
 *  - disconnecting pauses that account's campaigns, wipes its session and unlinks it; history is kept
 * The browser part is behind a small driver so the rules can be tested without LinkedIn.
 */
import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { BridgeError } from "@/lib/bridge";
import { encryptSecret } from "@/lib/crypto";

type Db = Database.Database;

export type LoginOutcome = { status: string; [k: string]: unknown };
export interface LoginDriver {
  start(accountId: string, email: string, password: string): Promise<LoginOutcome>;
  verify(accountId: string, code: string): Promise<LoginOutcome>;
  await(accountId: string): Promise<LoginOutcome>;
  close(accountId: string): Promise<void>;
}

/** The real driver. Loaded lazily so tests never start a browser. */
export const realDriver: LoginDriver = {
  async start(id, email, password) { return (await import("@/lib/linkedin/session")).startHeadlessLogin(id, email, password) as Promise<LoginOutcome>; },
  async verify(id, code) { return (await import("@/lib/linkedin/session")).submitLoginChallenge(id, code) as Promise<LoginOutcome>; },
  async await(id) { return (await import("@/lib/linkedin/session")).awaitLoginApproval(id) as Promise<LoginOutcome>; },
  async close(id) { await (await import("@/lib/linkedin/session")).closeSession(id); },
};

const cleanEmail = (e: unknown) => (typeof e === "string" ? e.trim().toLowerCase() : "");
const need = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new BridgeError(400, "bad_request", `${what} is required.`);
  return v.trim();
};

/** Finds or creates the account row for (console user, email), applying the one-person-one-account rules. */
export function claimAccount(db: Db, consoleUserId: string, emailIn: string, name?: string): string {
  const userId = need(consoleUserId, "console_user_id");
  const email = cleanEmail(emailIn);
  if (!email) throw new BridgeError(400, "bad_request", "email is required.");
  const mine = db.prepare("SELECT id, email FROM accounts WHERE console_user_id = ?").get(userId) as { id: string; email: string } | undefined;
  if (mine && mine.email.toLowerCase() !== email) {
    throw new BridgeError(409, "already_linked", "This person already has a LinkedIn account connected. Disconnect it first.");
  }
  const byEmail = db.prepare("SELECT id, console_user_id FROM accounts WHERE lower(email) = ?").get(email) as { id: string; console_user_id: string | null } | undefined;
  if (byEmail && byEmail.console_user_id && byEmail.console_user_id !== userId) {
    throw new BridgeError(409, "account_taken", "That LinkedIn account is already connected to someone else.");
  }
  if (byEmail) {
    if (!byEmail.console_user_id) db.prepare("UPDATE accounts SET console_user_id = ? WHERE id = ?").run(userId, byEmail.id);
    return byEmail.id;
  }
  const id = randomUUID();
  db.prepare("INSERT INTO accounts (id, name, email, console_user_id) VALUES (?,?,?,?)").run(id, (name ?? "").trim() || email, email, userId);
  return id;
}

const accountOwned = (db: Db, accountId: string) => {
  const a = db.prepare("SELECT id, console_user_id FROM accounts WHERE id = ?").get(accountId) as { id: string; console_user_id: string | null } | undefined;
  if (!a) throw new BridgeError(404, "account_not_found", "No such LinkedIn account.");
  return a;
};

export async function loginStart(db: Db, b: { console_user_id?: string; email?: string; password?: string; name?: string }, driver: LoginDriver = realDriver) {
  const password = need(b.password, "password");
  const accountId = claimAccount(db, need(b.console_user_id, "console_user_id"), need(b.email, "email"), b.name);
  const res = await driver.start(accountId, cleanEmail(b.email), password);
  return { account_id: accountId, ...res };
}

export async function loginVerify(db: Db, b: { account_id?: string; code?: string }, driver: LoginDriver = realDriver) {
  const id = need(b.account_id, "account_id"); accountOwned(db, id);
  return { account_id: id, ...(await driver.verify(id, need(b.code, "code"))) };
}

export async function loginAwait(db: Db, b: { account_id?: string }, driver: LoginDriver = realDriver) {
  const id = need(b.account_id, "account_id"); accountOwned(db, id);
  return { account_id: id, ...(await driver.await(id)) };
}

/** Fallback: the rep pastes their own li_at cookie. */
export async function linkWithCookie(db: Db, b: { console_user_id?: string; email?: string; li_at?: string; name?: string }, driver: LoginDriver = realDriver) {
  const liAt = need(b.li_at, "li_at");
  const id = claimAccount(db, need(b.console_user_id, "console_user_id"), need(b.email, "email"), b.name);
  const state = { cookies: [{ name: "li_at", value: liAt, domain: ".linkedin.com", path: "/", httpOnly: true, secure: true, sameSite: "None" }], origins: [] };
  db.prepare("UPDATE accounts SET cookies_json = ?, is_authenticated = 1 WHERE id = ?").run(encryptSecret(JSON.stringify(state)), id);
  await driver.close(id);
  return { account_id: id, status: "authenticated" };
}

/** Unlinks a rep's account: pauses its campaigns, wipes the session, keeps history. */
export async function disconnectAccount(db: Db, accountId: string, driver: LoginDriver = realDriver) {
  accountOwned(db, accountId);
  const paused = db.prepare("UPDATE runs SET status = 'paused' WHERE account_id = ? AND status = 'running'").run(accountId).changes;
  db.prepare("UPDATE accounts SET cookies_json = NULL, is_authenticated = 0, console_user_id = NULL WHERE id = ?").run(accountId);
  await driver.close(accountId);
  return { disconnected: true, runs_paused: paused };
}

export function setAccountProxy(db: Db, accountId: string, url: string | null) {
  accountOwned(db, accountId);
  if (url === null || url === "") { db.prepare("UPDATE accounts SET proxy_url = NULL WHERE id = ?").run(accountId); return { proxy: false }; }
  let u: URL;
  try { u = new URL(url); } catch { throw new BridgeError(400, "bad_proxy", "Proxy must be a full address such as http://user:pass@host:port."); }
  if (!["http:", "https:", "socks5:"].includes(u.protocol)) throw new BridgeError(400, "bad_proxy", "Proxy must start with http://, https:// or socks5://.");
  db.prepare("UPDATE accounts SET proxy_url = ? WHERE id = ?").run(encryptSecret(url), accountId);
  return { proxy: true };
}

/** What the Console shows: who owns each account, whether it is healthy, what it did today. Never returns secrets. */
export function listAccounts(db: Db) {
  const rows = db.prepare(`SELECT id, name, email, console_user_id, is_authenticated, proxy_url IS NOT NULL AS has_proxy,
                                  daily_connection_limit AS invite_limit, daily_message_limit AS message_limit,
                                  inbox_synced_at, accepted_sync_at FROM accounts ORDER BY created_at`).all() as
    { id: string; name: string; email: string; console_user_id: string | null; is_authenticated: number; has_proxy: number;
      invite_limit: number | null; message_limit: number | null; inbox_synced_at: string | null; accepted_sync_at: string | null }[];
  const count = (accountId: string, col: string) => (db.prepare(
    `SELECT COUNT(*) c FROM targets t WHERE t.${col} >= date('now') AND EXISTS
       (SELECT 1 FROM run_profiles rp JOIN runs r ON r.id = rp.run_id WHERE rp.target_id = t.id AND r.account_id = ?)`).get(accountId) as { c: number }).c;
  return {
    accounts: rows.map((r) => ({
      account_id: r.id, name: r.name, email: r.email, console_user_id: r.console_user_id,
      status: r.is_authenticated ? "connected" : "needs_login",
      has_proxy: !!r.has_proxy, invite_limit: r.invite_limit, message_limit: r.message_limit,
      invites_today: count(r.id, "connection_requested_at"), messages_today: count(r.id, "message_sent_at"),
      inbox_synced_at: r.inbox_synced_at, accepted_synced_at: r.accepted_sync_at,
    })),
  };
}
