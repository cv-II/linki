/**
 * Event push (E23): Linki tells the Console about new events straight away instead of waiting for the Console to ask.
 * Optional speed-up: the feed (GET /api/bridge/events) stays the source of truth, and the Console counts an event
 * seen both ways once. Needs CONSOLE_WEBHOOK_URL and CONSOLE_WEBHOOK_SECRET; does nothing without them.
 * The cursor moves only after the Console answered 2xx, so a down Console just means the events go next time.
 */
import type Database from "better-sqlite3";
import { captureEvents } from "@/lib/bridge";

type Db = Database.Database;
const BATCH = 500;

export interface PushConfig { url?: string; secret?: string }
export const pushConfigFromEnv = (env: NodeJS.ProcessEnv = process.env): PushConfig => ({
  url: env.CONSOLE_WEBHOOK_URL || undefined, secret: env.CONSOLE_WEBHOOK_SECRET || undefined,
});

const isoOf = (s: string): string => {
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};

/** Sends everything not yet sent. Returns how many events the Console accepted. Never throws. */
export async function pushNewEvents(db: Db, cfg: PushConfig = pushConfigFromEnv(), fetchImpl: typeof fetch = fetch): Promise<number> {
  if (!cfg.url || !cfg.secret) return 0;
  db.exec("CREATE TABLE IF NOT EXISTS bridge_push_state (id INTEGER PRIMARY KEY CHECK (id = 1), last_id INTEGER NOT NULL)");
  db.prepare("INSERT OR IGNORE INTO bridge_push_state (id, last_id) VALUES (1, 0)").run();
  try { captureEvents(db); } catch { return 0; }
  let sent = 0;
  for (;;) {
    const last = (db.prepare("SELECT last_id FROM bridge_push_state WHERE id = 1").get() as { last_id: number }).last_id;
    const rows = db.prepare("SELECT id, type, external_lead_id, at, account_id FROM bridge_events WHERE id > ? ORDER BY id LIMIT ?").all(last, BATCH) as
      { id: number; type: string; external_lead_id: string; at: string; account_id: string | null }[];
    if (!rows.length) return sent;
    const events = rows.map((r) => ({ id: String(r.id), type: r.type, lead_id: r.external_lead_id, at: isoOf(r.at), account_id: r.account_id }));
    try {
      const res = await fetchImpl(cfg.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-webhook-secret": cfg.secret },
        body: JSON.stringify({ events }),
      });
      if (!res.ok) { console.warn(`[bridge-push] Console answered ${res.status}; will retry`); return sent; }
    } catch (e) {
      console.warn("[bridge-push] Console unreachable; will retry:", e instanceof Error ? e.message : e);
      return sent;
    }
    db.prepare("UPDATE bridge_push_state SET last_id = ? WHERE id = 1").run(rows[rows.length - 1].id);
    sent += rows.length;
    if (rows.length < BATCH) return sent;
  }
}
