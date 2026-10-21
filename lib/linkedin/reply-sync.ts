import type { Page } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getDb } from "@/lib/db";
import { getSessionPage, saveSessionState, markNeedsReauth } from "@/lib/linkedin/session";
import { applyReplies, extractConversations, type InboxConversation } from "@/lib/linkedin/reply-detect";
import { premium } from "@/lib/premium";

/**
 * LinkedIn inbox reply detection (X11). READ ONLY: it opens the messaging page like a person would and reads what LinkedIn
 * itself loads for the inbox. It never sends, opens a thread for writing, or marks anything as read.
 *
 * Why it listens instead of calling a fixed URL: LinkedIn's messaging GraphQL query ids change without notice. Listening to
 * the page's own requests keeps working when the id changes. If LinkedIn changes the response shape, set
 * LINKI_DEBUG_MESSAGING_DIR to save the raw responses, then adjust reply-detect.ts.
 */
const SYNC_INTERVAL_MS = 15 * 60 * 1000;
const WAIT_FOR_INBOX_MS = 15_000;
const INBOX_URL_RE = /voyagerMessagingGraphQL|messengerConversations|messengerMessages|\/messaging\/(conversations|graphql)/i;

export function shouldSyncInbox(accountId: string): boolean {
  const row = getDb().prepare("SELECT inbox_synced_at FROM accounts WHERE id = ?").get(accountId) as { inbox_synced_at: string | null } | undefined;
  if (!row) return false;
  if (!row.inbox_synced_at) return true;
  const t = new Date(row.inbox_synced_at.replace(" ", "T") + "Z").getTime();
  return Number.isNaN(t) || Date.now() - t >= SYNC_INTERVAL_MS;
}

/** Reads the account's inbox once and marks repliers. Returns how many people were newly marked. */
export async function syncAccountInbox(accountId: string): Promise<number> {
  const db = getDb();
  const page: Page = await getSessionPage(accountId);
  const conversations: InboxConversation[] = [];
  let seen = 0;
  const debugDir = process.env.LINKI_DEBUG_MESSAGING_DIR;
  try {
    page.on("response", async (res) => {
      try {
        if (!INBOX_URL_RE.test(res.url()) || !(res.headers()["content-type"] ?? "").includes("json")) return;
        const body = await res.json();
        seen++;
        if (debugDir) { mkdirSync(debugDir, { recursive: true }); writeFileSync(join(debugDir, `inbox-${Date.now()}-${seen}.json`), JSON.stringify(body)); }
        conversations.push(...extractConversations(body));
      } catch { /* not JSON, or the page closed: ignore */ }
    });
    await page.goto("https://www.linkedin.com/messaging/", { waitUntil: "domcontentloaded", timeout: 35000 });
    const deadline = Date.now() + WAIT_FOR_INBOX_MS;
    while (Date.now() < deadline && seen === 0) await page.waitForTimeout(500);
    await page.waitForTimeout(1500 + Math.random() * 1000); // let the rest of the page's responses arrive
    if (/\/login|\/authwall|\/checkpoint|\/uas\//.test(page.url())) {
      console.warn(`[reply-sync] session looks logged out (${page.url()})`);
      return 0;
    }
    return applyReplies(db, conversations);
  } finally {
    let url = "";
    try { url = page.url(); } catch { /* gone */ }
    try { await page.close(); } catch { /* ignore */ }
    if (/\/login|\/authwall|\/checkpoint|\/uas\//.test(url)) {
      try { await markNeedsReauth(accountId); } catch { /* ignore */ }
    } else {
      try { await saveSessionState(accountId); } catch { /* ignore */ }
    }
    db.prepare("UPDATE accounts SET inbox_synced_at = datetime('now') WHERE id = ?").run(accountId);
  }
}

/** The paid build's reader when present, ours otherwise. */
export const inboxReplies = {
  shouldSyncInbox: (id: string) => (premium?.replies ? premium.replies.shouldSyncInbox(id) : shouldSyncInbox(id)),
  syncAccountInbox: (id: string) => (premium?.replies ? premium.replies.syncAccountInbox(id) : syncAccountInbox(id)),
};
