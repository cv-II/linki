// Run with: npx tsx --test tests/bridge-limits.test.ts   (throwaway database)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LINKI_DB_PATH = join(mkdtempSync(join(tmpdir(), "linki-limits-")), "test.db");
process.env.NEXTAUTH_SECRET = "test";
let db: import("better-sqlite3").Database;
let B: typeof import("../lib/bridge");
const cfg = {};
after(() => setTimeout(() => process.exit(process.exitCode ?? 0), 50));
const lead = (n: number) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, name: `Person ${n}`, email: `p${n}@example.com`, linkedin_url: `https://www.linkedin.com/in/lim-person-${n}` });
const limits = () => db.prepare("SELECT daily_connection_limit c, daily_message_limit m FROM accounts WHERE id='acc1'").get() as { c: number; m: number };

before(async () => {
  const { getDb } = await import("../lib/db");
  B = await import("../lib/bridge");
  db = getDb();
  db.prepare("INSERT INTO accounts (id, name, email, is_authenticated, daily_connection_limit, daily_message_limit) VALUES ('acc1','Test','t@example.com',1,20,50)").run();
  db.prepare("INSERT INTO workflows (id, name) VALUES ('wf1','Seq')").run();
  db.prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, step_type, track) VALUES ('s1','wf1',1,'connect','linkedin')").run();
});

test("the Console campaign's limits lower the account's daily limits while it runs, and restore after", () => {
  B.enrolLeads(db, "A", [lead(1)], cfg, { name: "A", daily_invites: 10, daily_messages: 20 });
  assert.deepEqual(limits(), { c: 20, m: 50 }); // nothing running yet: unchanged
  B.setCampaignStatus(db, "A", "start", { daily_invites: 10, daily_messages: 20 });
  assert.deepEqual(limits(), { c: 10, m: 20 });
  B.setCampaignStatus(db, "A", "pause");
  assert.deepEqual(limits(), { c: 20, m: 50 });
});

test("two running campaigns add up, and the total never goes above the ceiling set in Linki", () => {
  B.enrolLeads(db, "B", [lead(2)], cfg, { name: "B", daily_invites: 5, daily_messages: 10 });
  B.setCampaignStatus(db, "A", "start");
  B.setCampaignStatus(db, "B", "start", { daily_invites: 5, daily_messages: 10 });
  assert.deepEqual(limits(), { c: 15, m: 30 });
  B.enrolLeads(db, "C", [lead(3)], cfg, { name: "C", daily_invites: 100, daily_messages: 200 });
  B.setCampaignStatus(db, "C", "start");
  assert.deepEqual(limits(), { c: 20, m: 50 }); // 115 and 230 asked for, ceiling 20 and 50 wins
  B.setCampaignStatus(db, "C", "stop");
  assert.deepEqual(limits(), { c: 15, m: 30 });
  B.setCampaignStatus(db, "A", "stop"); B.setCampaignStatus(db, "B", "stop");
  assert.deepEqual(limits(), { c: 20, m: 50 });
});

test("a limit changed by hand in Linki becomes the new ceiling", () => {
  B.enrolLeads(db, "D", [lead(4)], cfg, { name: "D", daily_invites: 8, daily_messages: 16 });
  B.setCampaignStatus(db, "D", "start");
  assert.deepEqual(limits(), { c: 8, m: 16 });
  db.prepare("UPDATE accounts SET daily_connection_limit = 30, daily_message_limit = 60 WHERE id='acc1'").run(); // someone edits in Linki
  B.setCampaignStatus(db, "D", "pause");
  assert.deepEqual(limits(), { c: 30, m: 60 });
});

test("bad limits are ignored and a campaign that never sent limits does not lower anything", () => {
  B.enrolLeads(db, "E", [lead(5)], cfg, { name: "E", daily_invites: 500, daily_messages: -3 } as any);
  assert.equal((db.prepare("SELECT daily_invites i, daily_messages m FROM bridge_campaigns WHERE external_id='E'").get() as any).i, null);
  B.setCampaignStatus(db, "E", "start");
  assert.deepEqual(limits(), { c: 30, m: 60 });
  B.setCampaignStatus(db, "E", "pause");
});

test("a limit of 0 is respected (no invites)", () => {
  B.enrolLeads(db, "F", [lead(6)], cfg, { name: "F", daily_invites: 0, daily_messages: 5 });
  B.setCampaignStatus(db, "F", "start");
  assert.deepEqual(limits(), { c: 0, m: 5 });
  B.setCampaignStatus(db, "F", "stop");
  assert.deepEqual(limits(), { c: 30, m: 60 });
});
