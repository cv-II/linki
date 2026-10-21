// Run with: npx tsx --test tests/reply-detect.test.ts   (uses a throwaway database; never touches linki.db)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LINKI_DB_PATH = join(mkdtempSync(join(tmpdir(), "linki-reply-")), "test.db");
process.env.NEXTAUTH_SECRET = "test";

let db: import("better-sqlite3").Database;
let R: typeof import("../lib/linkedin/reply-detect");
let B: typeof import("../lib/bridge");
after(() => setTimeout(() => process.exit(process.exitCode ?? 0), 50));

const ME = "urn:li:fsd_profile:ACoAAME";
const ANNA = "urn:li:fsd_profile:ACoAAANNA";
const BOB = "urn:li:fsd_profile:ACoAABOB";
const STRANGER = "urn:li:fsd_profile:ACoAASTRANGER";
const T0 = Date.parse("2026-10-20T10:00:00Z"); // our message to Anna and Bob

// A response shaped like LinkedIn's normalized messaging data: objects point at each other by id.
function inbox(conv: { id: string; people: string[]; msgs: { from: string; at: number }[] }[]) {
  const included: unknown[] = [];
  for (const c of conv) {
    const parts = c.people.map((u, i) => ({ entityUrn: `urn:li:msg_participant:${c.id}:${i}`, hostIdentityUrn: u, $type: "com.linkedin.messenger.MessagingParticipant" }));
    const msgs = c.msgs.map((m, i) => ({ entityUrn: `urn:li:msg_message:${c.id}:${i}`, deliveredAt: m.at, "*sender": `urn:li:msg_participant:${c.id}:${c.people.indexOf(m.from)}`, $type: "com.linkedin.messenger.Message" }));
    included.push(...parts, ...msgs, { entityUrn: `urn:li:msg_conversation:${c.id}`, $type: "com.linkedin.messenger.Conversation", "*conversationParticipants": parts.map((p) => p.entityUrn), messages: { elements: msgs.map((m) => m.entityUrn) } });
  }
  return { data: {}, included };
}

before(async () => {
  const { getDb } = await import("../lib/db");
  R = await import("../lib/linkedin/reply-detect");
  B = await import("../lib/bridge");
  db = getDb();
  const sent = "2026-10-20 10:00:00";
  const ins = db.prepare("INSERT INTO targets (id, linkedin_url, full_name, messaging_urn, message_sent_at, external_id) VALUES (?,?,?,?,?,?)");
  ins.run("t-anna", "https://www.linkedin.com/in/anna", "Anna", ANNA, sent, "00000000-0000-4000-8000-000000000001");
  ins.run("t-bob", "https://www.linkedin.com/in/bob", "Bob", BOB, sent, "00000000-0000-4000-8000-000000000002");
  ins.run("t-new", "https://www.linkedin.com/in/new", "Never messaged", "urn:li:fsd_profile:ACoAANEW", null, "00000000-0000-4000-8000-000000000003");
});

test("a message from the person after ours marks them as replied, with the time of their first reply", () => {
  const payload = inbox([{ id: "c1", people: [ME, ANNA], msgs: [{ from: ME, at: T0 }, { from: ANNA, at: T0 + 3_600_000 }, { from: ANNA, at: T0 + 7_200_000 }] }]);
  const convs = R.extractConversations(payload);
  assert.equal(convs.length, 1);
  assert.equal(R.applyReplies(db, convs), 1);
  assert.equal((db.prepare("SELECT last_replied_at v FROM targets WHERE id='t-anna'").get() as any).v, "2026-10-20 11:00:00");
});

test("our own message is never counted as a reply", () => {
  const convs = R.extractConversations(inbox([{ id: "c2", people: [ME, BOB], msgs: [{ from: ME, at: T0 }, { from: ME, at: T0 + 60_000 }] }]));
  assert.equal(R.applyReplies(db, convs), 0);
  assert.equal((db.prepare("SELECT last_replied_at v FROM targets WHERE id='t-bob'").get() as any).v, null);
});

test("a message older than ours, a stranger, and a person we never messaged are all ignored", () => {
  const convs = R.extractConversations(inbox([
    { id: "c3", people: [ME, BOB], msgs: [{ from: BOB, at: T0 - 86_400_000 }, { from: ME, at: T0 }] },
    { id: "c4", people: [ME, STRANGER], msgs: [{ from: STRANGER, at: T0 + 1000 }] },
    { id: "c5", people: [ME, "urn:li:fsd_profile:ACoAANEW"], msgs: [{ from: "urn:li:fsd_profile:ACoAANEW", at: T0 + 1000 }] },
  ]));
  assert.equal(R.applyReplies(db, convs), 0);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM targets WHERE last_replied_at IS NOT NULL").get() as any).c, 1); // only Anna from the first test
});

test("running it twice changes nothing", () => {
  const convs = R.extractConversations(inbox([{ id: "c1", people: [ME, ANNA], msgs: [{ from: ME, at: T0 }, { from: ANNA, at: T0 + 3_600_000 }] }]));
  assert.equal(R.applyReplies(db, convs), 0);
  assert.equal((db.prepare("SELECT last_replied_at v FROM targets WHERE id='t-anna'").get() as any).v, "2026-10-20 11:00:00");
});

test("the bridge feed then shows exactly one linkedin_reply, for the Console's lead id", () => {
  const ev = B.readEvents(db, null, 100).events.filter((e) => e.type === "linkedin_reply");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].lead_id, "00000000-0000-4000-8000-000000000001");
  assert.equal(B.readEvents(db, null, 100).events.filter((e) => e.type === "linkedin_reply").length, 1); // reading again adds none
});

test("odd or empty responses do not throw", () => {
  for (const x of [null, {}, [], "text", 5, { included: [{ entityUrn: "a" }] }]) assert.deepEqual(R.extractConversations(x), []);
});
