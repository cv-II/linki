// Run with: npx tsx --test tests/bridge-accounts.test.ts   (throwaway database; no browser, no LinkedIn)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LINKI_DB_PATH = join(mkdtempSync(join(tmpdir(), "linki-multi-")), "test.db");
process.env.NEXTAUTH_SECRET = "test";

let db: import("better-sqlite3").Database;
let B: typeof import("../lib/bridge");
let A: typeof import("../lib/bridge-accounts");
after(() => setTimeout(() => process.exit(process.exitCode ?? 0), 50));

const lead = (n: number) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, name: `Person ${n}`, email: `m${n}@example.com`, linkedin_url: `https://www.linkedin.com/in/multi-${n}` });
const calls: string[] = [];
const driver: import("../lib/bridge-accounts").LoginDriver = {
  async start(id, email) { calls.push(`start:${email}`); return { status: "challenge" }; },
  async verify(id, code) { calls.push(`verify:${code}`); return { status: "authenticated" }; },
  async await() { return { status: "authenticated" }; },
  async close(id) { calls.push(`close:${id}`); },
};
const connect = (id: string) => db.prepare("UPDATE accounts SET is_authenticated = 1 WHERE id = ?").run(id);

before(async () => {
  const { getDb } = await import("../lib/db");
  B = await import("../lib/bridge"); A = await import("../lib/bridge-accounts");
  db = getDb();
  B.ensureBridgeSchema(db);
  db.prepare("INSERT INTO workflows (id, name) VALUES ('wf1','Seq')").run();
  db.prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, step_type, track) VALUES ('s1','wf1',1,'connect','linkedin')").run();
});

test("each rep gets their own account; one person one account, one account one person", async () => {
  const a = await A.loginStart(db, { console_user_id: "u-asha", email: "Asha@x.com", password: "secret" }, driver);
  const b = await A.loginStart(db, { console_user_id: "u-ben", email: "ben@x.com", password: "secret" }, driver);
  assert.notEqual(a.account_id, b.account_id);
  assert.deepEqual(calls.slice(0, 2), ["start:asha@x.com", "start:ben@x.com"]);
  // repeating login for the same person re-uses the account
  const again = await A.loginStart(db, { console_user_id: "u-asha", email: "asha@x.com", password: "secret" }, driver);
  assert.equal(again.account_id, a.account_id);
  await assert.rejects(A.loginStart(db, { console_user_id: "u-asha", email: "other@x.com", password: "p" }, driver), { code: "already_linked" });
  await assert.rejects(A.loginStart(db, { console_user_id: "u-cy", email: "ben@x.com", password: "p" }, driver), { code: "account_taken" });
  await assert.rejects(A.loginStart(db, { console_user_id: "u-cy", email: "cy@x.com" }, driver), { code: "bad_request" });
  assert.equal((await A.loginVerify(db, { account_id: a.account_id, code: "123456" }, driver)).status, "authenticated");
  await assert.rejects(A.loginVerify(db, { account_id: "nope", code: "1" }, driver), { code: "account_not_found" });
});

test("the password is never written to the database", () => {
  const dump = JSON.stringify(db.prepare("SELECT * FROM accounts").all());
  assert.ok(!dump.includes("secret"));
});

test("one campaign runs through several accounts, split by who enrols", () => {
  const [asha, ben] = (db.prepare("SELECT id FROM accounts ORDER BY created_at, rowid").all() as { id: string }[]).map((r) => r.id);
  connect(asha); connect(ben);
  const mk = (id: string) => ({ accountId: id, explicitAccount: true });
  assert.equal(B.enrolLeads(db, "camp-m", [lead(1), lead(2)], mk(asha), { name: "Multi", daily_invites: 10, daily_messages: 20 }).enrolled, 2);
  assert.equal(B.enrolLeads(db, "camp-m", [lead(3)], mk(ben), { daily_invites: 5, daily_messages: 10 }).enrolled, 1);
  // a lead already in the campaign (through another rep) is not enrolled twice
  assert.equal(B.enrolLeads(db, "camp-m", [lead(1)], mk(ben)).skipped.already_enrolled, 1);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM bridge_campaign_runs WHERE external_id='camp-m'").get() as any).c, 2);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM bridge_campaigns WHERE external_id='camp-m'").get() as any).c, 1);
  // each run belongs to its rep's account
  const runs = db.prepare("SELECT r.account_id a, COUNT(rp.id) n FROM runs r JOIN run_profiles rp ON rp.run_id = r.id GROUP BY r.id ORDER BY n DESC").all() as { a: string; n: number }[];
  assert.deepEqual(runs.map((r) => [r.a, r.n]), [[asha, 2], [ben, 1]]);
});

test("enrolling through an account that is not connected is refused", () => {
  db.prepare("INSERT INTO accounts (id, name, email, is_authenticated) VALUES ('dead','Dead','dead@x.com',0)").run();
  assert.throws(() => B.enrolLeads(db, "camp-m", [lead(9)], { accountId: "dead", explicitAccount: true }), { code: "account_not_connected" });
  assert.throws(() => B.enrolLeads(db, "camp-m", [lead(9)], { accountId: "missing", explicitAccount: true }), { code: "account_not_connected" });
});

test("start, pause and stop act on every run; limits are per account", () => {
  const [asha, ben] = (db.prepare("SELECT id FROM accounts ORDER BY created_at, rowid LIMIT 2").all() as { id: string }[]).map((r) => r.id);
  assert.equal(B.setCampaignStatus(db, "camp-m", "start").status, "running");
  const st = () => (db.prepare("SELECT r.status s FROM bridge_campaign_runs x JOIN runs r ON r.id = x.run_id WHERE x.external_id='camp-m'").all() as { s: string }[]).map((r) => r.s);
  assert.deepEqual(st(), ["running", "running"]);
  const lim = (id: string) => db.prepare("SELECT daily_connection_limit c, daily_message_limit m FROM accounts WHERE id = ?").get(id) as { c: number; m: number };
  // both reps run the same campaign, so the campaign's own limits (10 / 20) apply to each account, capped by its ceiling (20 / 50)
  assert.ok(lim(asha).c <= 20 && lim(ben).c <= 20);
  B.setCampaignStatus(db, "camp-m", "pause");
  assert.deepEqual(st(), ["paused", "paused"]);
  B.setCampaignStatus(db, "camp-m", "stop");
  assert.deepEqual(st(), ["completed", "completed"]);
  assert.throws(() => B.setCampaignStatus(db, "camp-m", "start"), { code: "campaign_stopped" });
  assert.equal((db.prepare("SELECT COUNT(*) c FROM run_profile_tracks WHERE state='pending'").get() as any).c, 0);
});

test("events say which LinkedIn account worked the lead", () => {
  const [asha, ben] = (db.prepare("SELECT id FROM accounts ORDER BY created_at, rowid LIMIT 2").all() as { id: string }[]).map((r) => r.id);
  db.prepare("UPDATE targets SET connection_requested_at = datetime('now') WHERE external_id IN (?, ?)").run(lead(1).id, lead(3).id);
  const ev = B.readEvents(db, null, 100).events.filter((e) => e.type === "invite_sent");
  const by = Object.fromEntries(ev.map((e) => [e.lead_id, e.account_id]));
  assert.equal(by[lead(1).id], asha); assert.equal(by[lead(3).id], ben);
});

test("cookie paste links an account; proxy is stored encrypted; accounts list hides secrets", async () => {
  const r = await A.linkWithCookie(db, { console_user_id: "u-dee", email: "dee@x.com", li_at: "AQEDAR-fake" }, driver);
  assert.equal(r.status, "authenticated");
  const raw = db.prepare("SELECT cookies_json FROM accounts WHERE id = ?").get(r.account_id) as { cookies_json: string };
  assert.ok(!raw.cookies_json.includes("AQEDAR-fake"));
  assert.deepEqual(A.setAccountProxy(db, r.account_id, "http://u:p@proxy.example:8080"), { proxy: true });
  assert.throws(() => A.setAccountProxy(db, r.account_id, "ftp://x"), { code: "bad_proxy" });
  const list = A.listAccounts(db).accounts;
  const dee = list.find((a) => a.account_id === r.account_id)!;
  assert.equal(dee.status, "connected"); assert.equal(dee.has_proxy, true);
  assert.ok(!JSON.stringify(list).includes("proxy.example") && !JSON.stringify(list).includes("AQEDAR"));
});

test("disconnect pauses its campaigns, wipes the session and unlinks the rep; a new rep can then take the account", async () => {
  const dee = db.prepare("SELECT id FROM accounts WHERE console_user_id = 'u-dee'").get() as { id: string };
  db.prepare("INSERT INTO lists (id,name) VALUES ('l-dee','x')").run();
  db.prepare("INSERT INTO runs (id, workflow_id, list_id, account_id, status) VALUES ('r-dee','wf1','l-dee',?, 'running')").run(dee.id);
  const out = await A.disconnectAccount(db, dee.id, driver);
  assert.equal(out.runs_paused, 1);
  const row = db.prepare("SELECT cookies_json c, is_authenticated a, console_user_id u FROM accounts WHERE id = ?").get(dee.id) as any;
  assert.deepEqual([row.c, row.a, row.u], [null, 0, null]);
  assert.ok(calls.includes(`close:${dee.id}`));
  const again = await A.loginStart(db, { console_user_id: "u-eli", email: "dee@x.com", password: "p" }, driver);
  assert.equal(again.account_id, dee.id);
});
