// Run with: npx tsx --test tests/bridge.test.ts   (uses a throwaway database; never touches linki.db)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LINKI_DB_PATH = join(mkdtempSync(join(tmpdir(), "linki-bridge-")), "test.db");
process.env.NEXTAUTH_SECRET = "test";

let db: import("better-sqlite3").Database;
let B: typeof import("../lib/bridge");
const cfg = {};
after(() => setTimeout(() => process.exit(process.exitCode ?? 0), 50)); // Linki starts an update-check timer; do not wait for it
const lead = (n: number, extra = {}) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, name: `Test Person ${n}`, title: "HR Head", company: "Example Co", email: `p${n}@example.com`, linkedin_url: `https://www.linkedin.com/in/test-person-${n}`, ...extra });

before(async () => {
  const { getDb } = await import("../lib/db");
  B = await import("../lib/bridge");
  db = getDb();
  db.prepare("INSERT INTO accounts (id, name, email, is_authenticated) VALUES ('acc1','Test','t@example.com',1)").run();
  db.prepare("INSERT INTO workflows (id, name) VALUES ('wf1','Seq')").run();
  db.prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, step_type, track) VALUES ('s1','wf1',1,'connect','linkedin')").run();
});

test("enrolling creates one target per lead, one run, tracks, and is safe to repeat", () => {
  const leads = [lead(1), lead(2), lead(3, { dnc: true })];
  const a = B.enrolLeads(db, "camp-1", leads, cfg, "Q4 HR leaders");
  assert.equal(a.enrolled, 2); assert.equal(a.skipped.do_not_contact, 1);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM targets WHERE external_id IS NOT NULL").get() as any).c, 2);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM runs").get() as any).c, 1);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM run_profile_tracks WHERE state='pending'").get() as any).c, 2);
  assert.equal((db.prepare("SELECT name FROM lists").get() as any).name, "Console: Q4 HR leaders");
  const b = B.enrolLeads(db, "camp-1", leads, cfg);
  assert.equal(b.enrolled, 0); assert.equal(b.skipped.already_enrolled, 2);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM runs").get() as any).c, 1);
});

test("a lead cannot be in two active campaigns", () => {
  db.prepare("INSERT INTO workflows (id, name) VALUES ('wf3','Other')").run();
  db.prepare("INSERT INTO workflow_steps (id, workflow_id, step_order, step_type, track) VALUES ('s3','wf3',1,'connect','linkedin')").run();
  const r = B.enrolLeads(db, "camp-2", [lead(1), lead(4)], { workflowId: "wf3" });
  assert.equal(r.enrolled, 1); assert.equal(r.skipped.active_elsewhere, 1);
});

test("bad input and missing setup are refused with plain codes", () => {
  assert.throws(() => B.enrolLeads(db, "camp-1", [], cfg), { code: "bad_request" });
  assert.throws(() => B.enrolLeads(db, "camp-1", [{} as any], cfg), { code: "bad_request" });
  assert.throws(() => B.enrolLeads(db, "camp-1", Array.from({ length: 501 }, (_, i) => lead(i + 100)), cfg), { code: "too_many" });
  db.prepare("INSERT INTO workflows (id, name) VALUES ('wf2','Second')").run();
  assert.throws(() => B.enrolLeads(db, "camp-new", [lead(50)], cfg), { code: "bridge_not_configured" }); // two workflows and none chosen
  const r = B.enrolLeads(db, "camp-new", [lead(50)], { workflowId: "wf1" });
  assert.equal(r.enrolled, 1);
  assert.throws(() => B.setCampaignStatus(db, "never-seen", "start"), { code: "campaign_not_found" });
});

test("start, pause, stop are repeatable; a stopped campaign cannot restart; stop skips waiting leads but keeps history", () => {
  assert.deepEqual(B.setCampaignStatus(db, "camp-1", "start"), { status: "running" });
  assert.deepEqual(B.setCampaignStatus(db, "camp-1", "start"), { status: "running" });
  assert.deepEqual(B.setCampaignStatus(db, "camp-1", "pause"), { status: "paused" });
  assert.deepEqual(B.setCampaignStatus(db, "camp-1", "stop"), { status: "completed" });
  assert.deepEqual(B.setCampaignStatus(db, "camp-1", "stop"), { status: "completed" });
  assert.deepEqual(B.setCampaignStatus(db, "camp-1", "pause"), { status: "completed" });
  assert.throws(() => B.setCampaignStatus(db, "camp-1", "start"), { code: "campaign_stopped" });
  assert.equal((db.prepare("SELECT COUNT(*) c FROM run_profile_tracks rt JOIN run_profiles rp ON rp.id=rt.run_profile_id JOIN runs r ON r.id=rp.run_id JOIN bridge_campaigns bc ON bc.run_id=r.id WHERE bc.external_id='camp-1' AND rt.state='skipped'").get() as any).c, 2);
});

test("removing a lead skips their active tracks, and an unknown lead is fine", () => {
  const l = lead(60);
  B.enrolLeads(db, "camp-new", [l], { workflowId: "wf1" });
  assert.equal(B.unenrolLead(db, l.id).unenrolled, 1);
  assert.equal(B.unenrolLead(db, l.id).unenrolled, 0);
  assert.equal(B.unenrolLead(db, "00000000-0000-4000-8000-ffffffffffff").unenrolled, 0);
});

test("events are derived from what the runner records, in order, once, and resume from a cursor", () => {
  const t = (n: number) => (db.prepare("SELECT id FROM targets WHERE external_id = ?").get(lead(n).id) as any).id as string;
  db.prepare("UPDATE targets SET connection_requested_at='2026-10-01 10:00:00', connected_at='2026-10-02 10:00:00', message_sent_at='2026-10-03 10:00:00' WHERE id=?").run(t(2));
  db.prepare("UPDATE targets SET connection_requested_at='2026-10-01 11:00:00', last_replied_at='2026-10-04 09:00:00' WHERE id=?").run(t(4));
  db.prepare("UPDATE targets SET email_replied_at='2026-10-05 08:00:00' WHERE id=?").run(t(50));
  const p1 = B.readEvents(db, null, 3);
  assert.equal(p1.events.length, 3); assert.equal(p1.next, p1.events[2].id);
  const rest = B.readEvents(db, p1.next, 100);
  const all = [...p1.events, ...rest.events];
  assert.equal(all.length, 6);
  assert.deepEqual(new Set(all.map((e) => e.type)), new Set(["invite_sent", "invite_accepted", "message_sent", "linkedin_reply", "email_reply"]));
  const ids = all.map((e) => Number(e.id)); assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.ok(all.every((e) => /^\d{4}-\d{2}-\d{2}T.*Z$/.test(e.at)));
  assert.equal(all.find((e) => e.type === "invite_accepted")!.lead_id, lead(2).id);
  // Nothing new: same cursor comes back, no events. Reading again from the start gives the same ids.
  const none = B.readEvents(db, rest.next, 100); assert.equal(none.events.length, 0); assert.equal(none.next, rest.next);
  assert.deepEqual(B.readEvents(db, null, 1000).events.map((e) => e.id), all.map((e) => e.id));
  // New facts appear later with higher ids.
  db.prepare("UPDATE targets SET connected_at='2026-10-06 10:00:00' WHERE id=?").run(t(4));
  const later = B.readEvents(db, rest.next, 100);
  assert.equal(later.events.length, 1); assert.equal(later.events[0].type, "invite_accepted");
});

test("a bounce becomes one email_bounced event", () => {
  db.prepare("UPDATE targets SET email_status='invalid' WHERE external_id = ?").run(lead(50).id);
  const ev = B.readEvents(db, null, 1000).events.filter((e) => e.type === "email_bounced");
  assert.equal(ev.length, 1); assert.equal(ev[0].lead_id, lead(50).id);
  assert.equal(B.readEvents(db, null, 1000).events.filter((e) => e.type === "email_bounced").length, 1);
});

test("Apollo lookup: found, not found, and the whole-batch problems", async () => {
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  assert.deepEqual(await B.apolloLookup("k", { name: "A B", company: "X" }, reply(200, { person: { id: "1", email: "a@x.com", title: "CHRO", country: "India" } })), { status: "matched", email: "a@x.com", title: "CHRO", country: "India" });
  assert.deepEqual(await B.apolloLookup("k", { name: "A B" }, reply(200, { person: null })), { status: "not_found" });
  assert.deepEqual(await B.apolloLookup("k", { name: "A B" }, reply(200, { person: { id: "1", email: null } })), { status: "not_found" });
  assert.equal((await B.apolloLookup("k", {}, reply(200, {}))).status, "failed");
  await assert.rejects(B.apolloLookup(null, { name: "A" }), { code: "key_missing" });
  await assert.rejects(B.apolloLookup("k", { name: "A" }, reply(401, {})), { code: "key_rejected" });
  await assert.rejects(B.apolloLookup("k", { name: "A" }, reply(429, {})), { code: "rate_limited" });
  await assert.rejects(B.apolloLookup("k", { name: "A" }, reply(503, {})), { code: "apollo_down" });
  await assert.rejects(B.apolloLookup("k", { name: "A" }, (async () => { throw new Error("offline"); }) as any), { code: "apollo_down" });
  let sent: any; await B.apolloLookup("k", { linkedin_url: "https://www.linkedin.com/in/x", name: "N" }, (async (_u: any, init: any) => { sent = JSON.parse(init.body); return new Response("{}"); }) as any);
  assert.equal(sent.linkedin_url, "https://www.linkedin.com/in/x"); assert.equal(sent.name, undefined);
});
