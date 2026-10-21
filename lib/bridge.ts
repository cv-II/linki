/**
 * Careervira Console bridge.
 *
 * A small set of server-to-server routes (pages/api/bridge/[...path].ts) that let the Careervira Console
 * drive Linki: enrol leads in a campaign, start / pause / stop it, take a lead out of every sequence, look a person up
 * in Apollo, and read what happened (invites, acceptances, messages, replies, bounces) as an ordered event feed.
 *
 * Design rules:
 *  - Nothing here changes how Linki sends. Sending is still done by the existing runner on the existing workflow.
 *  - Everything is safe to repeat (enrolling, stopping, unenrolling, reading events).
 *  - The Console's lead id is stored on the target as `external_id`. Events are reported with that id.
 *  - Events are DERIVED from the timestamps the runner already writes on targets (connection_requested_at, connected_at,
 *    message_sent_at, last_replied_at, email_replied_at, email_status) so the runner itself is not modified.
 *
 * Auth: the existing proxy already requires the x-internal-secret header (INTERNAL_API_SECRET) on every /api/* route.
 * See docs/BRIDGE.md. Spec of what the Console expects: careervira-crm/linki-patches/PATCHSET_SPEC.md.
 */
import type Database from "better-sqlite3";
import { randomUUID } from "crypto";

type Db = Database.Database;

export class BridgeError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export interface BridgeLead {
  id: string; name?: string | null; title?: string | null; company?: string | null; email?: string | null;
  linkedin_url?: string | null; country?: string | null; dnc?: boolean;
}

export function ensureBridgeSchema(db: Db): void {
  try { db.exec("ALTER TABLE targets ADD COLUMN external_id TEXT"); } catch { /* already there */ }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_targets_external_id ON targets(external_id) WHERE external_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS bridge_campaigns (
      external_id TEXT PRIMARY KEY,
      name TEXT,
      workflow_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      list_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS bridge_accounts (
      account_id TEXT PRIMARY KEY,
      ceiling_connection INTEGER NOT NULL,
      ceiling_message INTEGER NOT NULL,
      applied_connection INTEGER,
      applied_message INTEGER
    );
    CREATE TABLE IF NOT EXISTS bridge_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      external_lead_id TEXT NOT NULL,
      at TEXT NOT NULL,
      UNIQUE(type, external_lead_id)
    );
  `);
  // Older databases made bridge_campaigns before the limit columns existed.
  try { db.exec("ALTER TABLE bridge_campaigns ADD COLUMN daily_invites INTEGER"); } catch { /* already there */ }
  try { db.exec("ALTER TABLE bridge_campaigns ADD COLUMN daily_messages INTEGER"); } catch { /* already there */ }
  // X12: one campaign can run through several LinkedIn accounts (one run per account).
  db.exec(`
    CREATE TABLE IF NOT EXISTS bridge_campaign_runs (
      external_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      list_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      PRIMARY KEY (external_id, account_id)
    );
  `);
  try { db.exec("ALTER TABLE bridge_events ADD COLUMN account_id TEXT"); } catch { /* already there */ }
  try { db.exec("ALTER TABLE accounts ADD COLUMN console_user_id TEXT"); } catch { /* already there */ }
  try { db.exec("ALTER TABLE accounts ADD COLUMN proxy_url TEXT"); } catch { /* already there */ }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_console_user ON accounts(console_user_id) WHERE console_user_id IS NOT NULL");
  backfillRuns(db);
}

/** Every first run of a campaign (bridge_campaigns) is also listed in bridge_campaign_runs. Safe to repeat. */
function backfillRuns(db: Db): void {
  db.exec(`INSERT OR IGNORE INTO bridge_campaign_runs (external_id, account_id, run_id, list_id, workflow_id)
           SELECT external_id, account_id, run_id, list_id, workflow_id FROM bridge_campaigns`);
}

interface CampRun { external_id: string; workflow_id: string; run_id: string; list_id: string; account_id: string }
const runsOf = (db: Db, externalId: string): CampRun[] => {
  backfillRuns(db);
  return db.prepare("SELECT external_id, workflow_id, run_id, list_id, account_id FROM bridge_campaign_runs WHERE external_id = ? ORDER BY rowid").all(externalId) as CampRun[];
};

const isoOf = (s: string | null | undefined): string => {
  if (!s) return new Date().toISOString();
  const t = s.includes("T") ? s : s.replace(" ", "T") + "Z";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};

export interface BridgeConfig { workflowId?: string; accountId?: string; explicitAccount?: boolean; emailAccountIds?: string[] }
export const configFromEnv = (env: NodeJS.ProcessEnv = process.env): BridgeConfig => ({
  workflowId: env.BRIDGE_WORKFLOW_ID || undefined,
  accountId: env.BRIDGE_ACCOUNT_ID || undefined,
  emailAccountIds: (env.BRIDGE_EMAIL_ACCOUNT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
});

/**
 * Finds (or lazily creates) the Linki run that stands for one Console campaign.
 * With cfg.accountId set explicitly (a rep's own account) the run for THAT account is used, so one campaign can
 * run through several accounts. Without it the campaign's first run is used (single-account behaviour).
 */
function campaignRow(db: Db, externalId: string, cfg: BridgeConfig, create: boolean, name?: string): CampRun | undefined {
  const existing = runsOf(db, externalId);
  if (cfg.accountId && cfg.explicitAccount) {
    const mine = existing.find((r) => r.account_id === cfg.accountId);
    if (mine || !create) return mine;
  } else if (existing.length || !create) {
    return existing[0];
  }

  let workflowId = cfg.workflowId ?? existing[0]?.workflow_id;
  if (!workflowId) {
    const all = db.prepare("SELECT id FROM workflows WHERE COALESCE(is_archived,0) = 0").all() as { id: string }[];
    if (all.length === 1) workflowId = all[0].id;
  }
  if (!workflowId) throw new BridgeError(409, "bridge_not_configured", "Set BRIDGE_WORKFLOW_ID to the Linki workflow (sequence) Console campaigns should use.");
  if (!db.prepare("SELECT 1 FROM workflows WHERE id = ?").get(workflowId)) throw new BridgeError(409, "bridge_not_configured", "BRIDGE_WORKFLOW_ID does not match a workflow.");

  let accountId = cfg.accountId;
  if (cfg.explicitAccount) {
    const a = accountId ? db.prepare("SELECT is_authenticated FROM accounts WHERE id = ?").get(accountId) as { is_authenticated: number } | undefined : undefined;
    if (!a || !a.is_authenticated) throw new BridgeError(409, "account_not_connected", "That LinkedIn account is not connected (or needs to be signed in again).");
  } else if (!accountId) {
    const acc = db.prepare("SELECT id FROM accounts WHERE is_authenticated = 1 ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
    accountId = acc?.id;
  }
  if (!accountId) throw new BridgeError(409, "bridge_not_configured", "No signed-in LinkedIn account. Set BRIDGE_ACCOUNT_ID or sign an account in.");

  const label = name?.trim() || existing[0] && (db.prepare("SELECT name FROM bridge_campaigns WHERE external_id = ?").get(externalId) as { name: string } | undefined)?.name || `Console campaign ${externalId.slice(0, 8)}`;
  const listId = randomUUID(); const runId = randomUUID();
  db.transaction(() => {
    db.prepare("INSERT INTO lists (id, name, description) VALUES (?, ?, ?)").run(listId, `Console: ${label}${existing.length ? ` (${accountId!.slice(0, 6)})` : ""}`, "Created by the Careervira Console bridge");
    // A campaign added to a new account starts in the same state the campaign is in: paused unless its other runs are running.
    const startRunning = existing.some((e) => (db.prepare("SELECT status FROM runs WHERE id = ?").get(e.run_id) as { status: string } | undefined)?.status === "running");
    db.prepare("INSERT INTO runs (id, workflow_id, list_id, account_id, email_account_id, status) VALUES (?, ?, ?, ?, ?, ?)")
      .run(runId, workflowId, listId, accountId, cfg.emailAccountIds?.[0] ?? null, startRunning ? "running" : "paused");
    if (startRunning) db.prepare("UPDATE runs SET started_at = datetime('now') WHERE id = ?").run(runId);
    if (!existing.length) {
      db.prepare("INSERT INTO bridge_campaigns (external_id, name, workflow_id, run_id, list_id, account_id) VALUES (?,?,?,?,?,?)")
        .run(externalId, label, workflowId, runId, listId, accountId);
    }
    db.prepare("INSERT OR IGNORE INTO bridge_campaign_runs (external_id, account_id, run_id, list_id, workflow_id) VALUES (?,?,?,?,?)")
      .run(externalId, accountId, runId, listId, workflowId);
  })();
  return campaignRow(db, externalId, cfg, false);
}

function splitName(full: string): { first: string; last: string } {
  const p = full.trim().split(/\s+/);
  return { first: p[0] ?? "", last: p.slice(1).join(" ") };
}

/** Adds leads to the campaign's run. Returns counts. Leads marked Do-not-contact are never enrolled. */
export function enrolLeads(db: Db, externalCampaignId: string, leads: BridgeLead[], cfg: BridgeConfig, meta?: CampaignMeta | string) {
  const name = typeof meta === "string" ? meta : meta?.name;
  if (!Array.isArray(leads) || leads.length === 0) throw new BridgeError(400, "bad_request", "leads must be a non-empty list.");
  if (leads.length > 500) throw new BridgeError(400, "too_many", "At most 500 leads per call.");
  for (const l of leads) if (!l || typeof l.id !== "string" || !l.id) throw new BridgeError(400, "bad_request", "Every lead needs an id.");

  const camp = campaignRow(db, externalCampaignId, cfg, true, name)!;
  if (typeof meta === "object") saveCampaignLimits(db, externalCampaignId, meta);
  const tracks = [...new Set((db.prepare("SELECT DISTINCT track FROM workflow_steps WHERE workflow_id = ?").all(camp.workflow_id) as { track: string }[]).map((r) => r.track))];
  if (tracks.length === 0) tracks.push("linkedin");
  const runEmail = (db.prepare("SELECT email_account_id FROM runs WHERE id = ?").get(camp.run_id) as { email_account_id: string | null } | undefined)?.email_account_id;
  const emailPool = [...new Set([...(cfg.emailAccountIds ?? []), ...(runEmail ? [runEmail] : [])])];

  const out = { enrolled: 0, skipped: { do_not_contact: 0, already_enrolled: 0, active_elsewhere: 0 } as Record<string, number> };
  let cursor = 0;
  db.transaction(() => {
    for (const l of leads) {
      if (l.dnc) { out.skipped.do_not_contact++; continue; }
      let t = db.prepare("SELECT id FROM targets WHERE external_id = ?").get(l.id) as { id: string } | undefined;
      const url = l.linkedin_url && /linkedin\.com\/in\//i.test(l.linkedin_url) ? l.linkedin_url : null;
      if (!t && url) t = db.prepare("SELECT id FROM targets WHERE linkedin_url = ?").get(url) as { id: string } | undefined;
      if (!t && l.email) t = db.prepare("SELECT id FROM targets WHERE lower(email) = lower(?) AND external_id IS NULL").get(l.email) as { id: string } | undefined;
      const nm = splitName(l.name ?? "");
      if (!t) {
        const id = randomUUID();
        db.prepare("INSERT INTO targets (id, linkedin_url, first_name, last_name, full_name, title, company, email, external_id) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(id, url, nm.first, nm.last, l.name ?? null, l.title ?? null, l.company ?? null, l.email ?? null, l.id);
        t = { id };
      } else {
        db.prepare("UPDATE targets SET external_id = COALESCE(external_id, ?), email = COALESCE(email, ?), linkedin_url = COALESCE(linkedin_url, ?) WHERE id = ?").run(l.id, l.email ?? null, url, t.id);
      }
      db.prepare("INSERT OR IGNORE INTO list_targets (list_id, target_id) VALUES (?, ?)").run(camp.list_id, t.id);

      if (db.prepare(`SELECT 1 FROM run_profiles rp JOIN runs r ON r.id = rp.run_id WHERE r.workflow_id = ? AND rp.target_id = ?`).get(camp.workflow_id, t.id)) { out.skipped.already_enrolled++; continue; }
      if (db.prepare(`SELECT 1 FROM run_profiles rp JOIN runs r ON r.id = rp.run_id
                      WHERE r.status IN ('running','paused') AND rp.target_id = ? AND r.id <> ?
                      AND EXISTS (SELECT 1 FROM run_profile_tracks rt WHERE rt.run_profile_id = rp.id AND rt.state NOT IN ('completed','failed','skipped'))`).get(t.id, camp.run_id)) { out.skipped.active_elsewhere++; continue; }

      const emailAccount = emailPool.length ? emailPool[cursor++ % emailPool.length] : null;
      const rpId = randomUUID();
      db.prepare("INSERT INTO run_profiles (id, run_id, target_id, email_account_id) VALUES (?,?,?,?)").run(rpId, camp.run_id, t.id, emailAccount);
      for (const track of tracks) {
        if (track === "email" && !emailAccount) continue;
        db.prepare("INSERT INTO run_profile_tracks (id, run_profile_id, track, state, current_step) VALUES (?,?,?,'pending',0)").run(randomUUID(), rpId, track);
      }
      out.enrolled++;
    }
  })();
  return out;
}

export interface CampaignMeta { name?: string; daily_invites?: number; daily_messages?: number }
const validLimit = (n: unknown, max: number): number | null => (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= max ? n : null);

/** Remember the Console campaign's own daily limits (invites 0-100, messages 0-200). Bad values are ignored, never guessed. */
export function saveCampaignLimits(db: Db, externalId: string, meta?: CampaignMeta) {
  if (!meta) return;
  const inv = validLimit(meta.daily_invites, 100); const msg = validLimit(meta.daily_messages, 200);
  if (inv === null && msg === null) return;
  db.prepare("UPDATE bridge_campaigns SET daily_invites = COALESCE(?, daily_invites), daily_messages = COALESCE(?, daily_messages) WHERE external_id = ?").run(inv, msg, externalId);
}

/**
 * Linki limits sending per LinkedIn account, not per campaign. So the account's daily limits are set to
 * the SUM of the limits of the Console campaigns running on it, but never above the ceiling the tech team set in Linki.
 * The ceiling is the account's own value the first time we touch it (and again whenever someone changes it in Linki).
 * When no Console campaign is running the account goes back to its ceiling, so other Linki use is unaffected.
 */
export function applyAccountLimits(db: Db, accountId: string) {
  backfillRuns(db);
  const acc = db.prepare("SELECT daily_connection_limit AS c, daily_message_limit AS m FROM accounts WHERE id = ?").get(accountId) as { c: number | null; m: number | null } | undefined;
  if (!acc) return;
  let st = db.prepare("SELECT * FROM bridge_accounts WHERE account_id = ?").get(accountId) as
    { ceiling_connection: number; ceiling_message: number; applied_connection: number | null; applied_message: number | null } | undefined;
  const curC = acc.c ?? 20; const curM = acc.m ?? 50;
  if (!st) {
    db.prepare("INSERT INTO bridge_accounts (account_id, ceiling_connection, ceiling_message) VALUES (?,?,?)").run(accountId, curC, curM);
    st = { ceiling_connection: curC, ceiling_message: curM, applied_connection: null, applied_message: null };
  } else {
    // If someone edited the limit in Linki since we last set it, that new value is the new ceiling.
    if (st.applied_connection !== null && curC !== st.applied_connection) st.ceiling_connection = curC;
    if (st.applied_message !== null && curM !== st.applied_message) st.ceiling_message = curM;
  }
  const run = db.prepare(`SELECT COALESCE(SUM(b.daily_invites),0) AS inv, COALESCE(SUM(b.daily_messages),0) AS msg,
                                 SUM(b.daily_invites IS NOT NULL) AS hasInv, SUM(b.daily_messages IS NOT NULL) AS hasMsg, COUNT(*) AS n
                          FROM bridge_campaign_runs x JOIN bridge_campaigns b ON b.external_id = x.external_id JOIN runs r ON r.id = x.run_id
                          WHERE x.account_id = ? AND r.status = 'running'`).get(accountId) as
    { inv: number; msg: number; hasInv: number | null; hasMsg: number | null; n: number };
  // A running campaign that never told us its limits does not lower anything (the ceiling still protects the account).
  const allInv = run.n > 0 && run.hasInv === run.n; const allMsg = run.n > 0 && run.hasMsg === run.n;
  const newC = allInv ? Math.min(st.ceiling_connection, run.inv) : st.ceiling_connection;
  const newM = allMsg ? Math.min(st.ceiling_message, run.msg) : st.ceiling_message;
  db.prepare("UPDATE accounts SET daily_connection_limit = ?, daily_message_limit = ? WHERE id = ?").run(newC, newM, accountId);
  db.prepare("UPDATE bridge_accounts SET ceiling_connection=?, ceiling_message=?, applied_connection=?, applied_message=? WHERE account_id = ?")
    .run(st.ceiling_connection, st.ceiling_message, newC, newM, accountId);
}

export function setCampaignStatus(db: Db, externalCampaignId: string, action: "start" | "pause" | "stop", meta?: CampaignMeta) {
  const out = setCampaignStatusInner(db, externalCampaignId, action, meta);
  for (const r of runsOf(db, externalCampaignId)) applyAccountLimits(db, r.account_id);
  return out;
}

/** Start / pause / stop act on every run of the campaign (one per rep account). */
function setCampaignStatusInner(db: Db, externalCampaignId: string, action: "start" | "pause" | "stop", meta?: CampaignMeta) {
  const runs = runsOf(db, externalCampaignId);
  if (!runs.length) throw new BridgeError(404, "campaign_not_found", "Linki has not seen this campaign yet. Enrol leads first.");
  if (action === "start") saveCampaignLimits(db, externalCampaignId, meta);
  const statusOf = (id: string) => (db.prepare("SELECT status FROM runs WHERE id = ?").get(id) as { status: string }).status;
  const all = runs.map((r) => ({ r, status: statusOf(r.run_id) }));
  if (action === "start") {
    const open = all.filter((x) => x.status !== "completed");
    if (!open.length) throw new BridgeError(409, "campaign_stopped", "This campaign was stopped and cannot be started again.");
    for (const x of open) db.prepare("UPDATE runs SET status = 'running', started_at = COALESCE(started_at, datetime('now')) WHERE id = ?").run(x.r.run_id);
    return { status: "running" };
  }
  if (action === "pause") {
    for (const x of all) if (x.status === "running") db.prepare("UPDATE runs SET status = 'paused' WHERE id = ?").run(x.r.run_id);
    return { status: all.every((x) => x.status === "completed") ? "completed" : "paused" };
  }
  // stop
  db.transaction(() => {
    for (const x of all) {
      if (x.status === "completed") continue;
      db.prepare(`UPDATE run_profile_tracks SET state = 'skipped', error_message = 'Campaign stopped from the Console'
                  WHERE state IN ('pending','in_progress') AND run_profile_id IN (SELECT id FROM run_profiles WHERE run_id = ?)`).run(x.r.run_id);
      db.prepare("UPDATE runs SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(x.r.run_id);
    }
  })();
  return { status: "completed" };
}

/**
 * Erases a person completely: their contact record, sequence progress, messages, replies, notes and logs.
 * Used when someone asks to be forgotten. Unknown person is fine (already gone). Never sends anything.
 */
export function eraseLead(db: Db, externalLeadId: string) {
  const targets = db.prepare("SELECT id FROM targets WHERE external_id = ?").all(externalLeadId) as { id: string }[];
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
  const hasCol = (table: string, col: string) => (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).some((c) => c.name === col);
  let removed = 0;
  db.transaction(() => {
    for (const t of targets) {
      // Things hanging off this person's place in a run (steps, tracks) go first.
      const profiles = (hasTable(tables, "run_profiles") ? db.prepare("SELECT id FROM run_profiles WHERE target_id = ?").all(t.id) : []) as { id: string }[];
      for (const table of tables) {
        if (table === "run_profiles" || table === "targets") continue;
        if (hasCol(table, "run_profile_id")) for (const p of profiles) removed += db.prepare(`DELETE FROM "${table}" WHERE run_profile_id = ?`).run(p.id).changes;
      }
      for (const table of tables) {
        if (table === "targets") continue;
        if (hasCol(table, "target_id")) removed += db.prepare(`DELETE FROM "${table}" WHERE target_id = ?`).run(t.id).changes;
      }
      removed += db.prepare("DELETE FROM targets WHERE id = ?").run(t.id).changes;
    }
    db.prepare("DELETE FROM bridge_events WHERE external_lead_id = ?").run(externalLeadId);
  })();
  return { erased: targets.length > 0, rows_removed: removed };
}
const hasTable = (tables: string[], name: string) => tables.includes(name);

/** Takes one lead out of every sequence. Unknown leads are fine (already gone). */
export function unenrolLead(db: Db, externalLeadId: string) {
  const t = db.prepare("SELECT id FROM targets WHERE external_id = ?").get(externalLeadId) as { id: string } | undefined;
  if (!t) return { unenrolled: 0 };
  const r = db.prepare(`UPDATE run_profile_tracks SET state = 'skipped', error_message = 'Removed from the sequence by the Console'
                        WHERE state IN ('pending','in_progress') AND run_profile_id IN (SELECT id FROM run_profiles WHERE target_id = ?)`).run(t.id);
  return { unenrolled: r.changes };
}

/** Copies new facts from the targets table into the ordered event list. Safe to run any number of times. */
export function captureEvents(db: Db): number {
  const before = (db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM bridge_events").get() as { m: number }).m;
  const ins = (type: string, col: string, where = `t.${col} IS NOT NULL`, atExpr = `t.${col}`) =>
    db.prepare(`INSERT OR IGNORE INTO bridge_events (type, external_lead_id, at)
                SELECT '${type}', t.external_id, ${atExpr} FROM targets t WHERE t.external_id IS NOT NULL AND ${where} ORDER BY ${atExpr}, t.id`).run();
  db.transaction(() => {
    ins("invite_sent", "connection_requested_at");
    ins("invite_accepted", "connected_at");
    ins("message_sent", "message_sent_at");
    ins("linkedin_reply", "last_replied_at");
    ins("email_reply", "email_replied_at");
    ins("email_bounced", "email_status", `t.email_status = 'invalid'`, `datetime('now')`);
    db.prepare(`INSERT OR IGNORE INTO bridge_events (type, external_lead_id, at)
                SELECT 'email_sent', t.external_id, COALESCE(MIN(rt.last_step_at), datetime('now'))
                FROM targets t JOIN run_profiles rp ON rp.target_id = t.id JOIN run_profile_tracks rt ON rt.run_profile_id = rp.id
                WHERE t.external_id IS NOT NULL AND rt.track = 'email' AND rt.last_email_subject IS NOT NULL GROUP BY t.external_id`).run();
    // Tag each event with the LinkedIn account that worked the lead (its most recent run).
    db.prepare(`UPDATE bridge_events SET account_id = (
                  SELECT r.account_id FROM run_profiles rp JOIN runs r ON r.id = rp.run_id JOIN targets t ON t.id = rp.target_id
                  WHERE t.external_id = bridge_events.external_lead_id ORDER BY rp.rowid DESC LIMIT 1)
                WHERE account_id IS NULL`).run();
  })();
  return (db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM bridge_events").get() as { m: number }).m - before;
}

export function readEvents(db: Db, after: string | null, limit: number) {
  const lim = Math.max(1, Math.min(1000, Math.floor(limit) || 200));
  const cursor = after && /^\d+$/.test(after) ? Number(after) : 0;
  captureEvents(db);
  const rows = db.prepare("SELECT id, type, external_lead_id, at, account_id FROM bridge_events WHERE id > ? ORDER BY id LIMIT ?").all(cursor, lim) as
    { id: number; type: string; external_lead_id: string; at: string; account_id: string | null }[];
  return {
    events: rows.map((r) => ({ id: String(r.id), type: r.type, lead_id: r.external_lead_id, at: isoOf(r.at), account_id: r.account_id })),
    next: rows.length ? String(rows[rows.length - 1].id) : (after ?? null),
  };
}

// ---- Apollo lookup -------------------------------------------------------------------------------------------

export interface EnrichInput { id?: string; name?: string; company?: string | null; linkedin_url?: string | null }
export type EnrichOutput = { status: "matched"; email: string; title: string | null; country: string | null } | { status: "not_found" } | { status: "failed"; message: string };

/** Looks one person up. Throws BridgeError with code key_missing / key_rejected / rate_limited / apollo_down when the whole batch should stop. */
export async function apolloLookup(apiKey: string | null, input: EnrichInput, fetchImpl: typeof fetch = fetch, base = process.env.BRIDGE_APOLLO_BASE || "https://api.apollo.io/api/v1"): Promise<EnrichOutput> {
  if (!apiKey) throw new BridgeError(409, "key_missing", "No Apollo key is saved in Linki (Settings, Integrations).");
  const body: Record<string, unknown> = { reveal_personal_emails: false };
  if (input.linkedin_url && /linkedin\.com\/in\//i.test(input.linkedin_url)) body.linkedin_url = input.linkedin_url;
  else if (input.name) { body.name = input.name; if (input.company) body.organization_name = input.company; }
  else return { status: "failed", message: "Needs a LinkedIn address or a name" };
  let res: Response;
  try { res = await fetchImpl(`${base}/people/match`, { method: "POST", headers: { "Content-Type": "application/json", "X-Api-Key": apiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) }); }
  catch (e) { throw new BridgeError(502, "apollo_down", `Apollo could not be reached: ${(e as Error).message}`); }
  if (res.status === 401 || res.status === 403) throw new BridgeError(401, "key_rejected", "Apollo refused the saved key.");
  if (res.status === 429) throw new BridgeError(429, "rate_limited", "Apollo rate limit reached. Try again later.");
  if (res.status >= 500) throw new BridgeError(502, "apollo_down", `Apollo answered ${res.status}.`);
  if (!res.ok) return { status: "failed", message: `Apollo answered ${res.status}` };
  const data = (await res.json().catch(() => null)) as { person?: { id?: string; email?: string | null; title?: string | null; country?: string | null } } | null;
  const p = data?.person;
  if (!p?.id || !p.email) return { status: "not_found" };
  return { status: "matched", email: String(p.email), title: p.title ?? null, country: p.country ?? null };
}
