// Run with: npx tsx --test tests/bridge-push.test.ts   (throwaway database; fake Console)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.LINKI_DB_PATH = join(mkdtempSync(join(tmpdir(), "linki-push-")), "test.db");
process.env.NEXTAUTH_SECRET = "test";
let db: import("better-sqlite3").Database;
let P: typeof import("../lib/bridge-push");
after(() => setTimeout(() => process.exit(process.exitCode ?? 0), 50));

before(async () => {
  const { getDb } = await import("../lib/db");
  const B = await import("../lib/bridge");
  P = await import("../lib/bridge-push");
  db = getDb(); B.ensureBridgeSchema(db);
});
const addEvents = (n: number, from = 0) => {
  for (let i = 0; i < n; i++) db.prepare("INSERT INTO bridge_events (type, external_lead_id, at) VALUES ('invite_sent', ?, '2026-10-20 10:00:00')").run(`lead-${from + i}`);
};
const cfg = { url: "http://console.test/api/webhooks/linki", secret: "s3" };

test("does nothing without a URL and secret", async () => {
  addEvents(2);
  assert.equal(await P.pushNewEvents(db, {}, (async () => { throw new Error("no call"); }) as any), 0);
});

test("sends new events with the secret, in order, then nothing the second time", async () => {
  const seen: { headers: any; body: any }[] = [];
  const ok = (async (_u: string, init: any) => { seen.push({ headers: init.headers, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; }) as any;
  assert.equal(await P.pushNewEvents(db, cfg, ok), 2);
  assert.equal(seen[0].headers["x-webhook-secret"], "s3");
  assert.deepEqual(seen[0].body.events.map((e: any) => e.lead_id), ["lead-0", "lead-1"]);
  assert.equal(seen[0].body.events[0].at, "2026-10-20T10:00:00.000Z");
  assert.equal(await P.pushNewEvents(db, cfg, ok), 0);
  assert.equal(seen.length, 1);
});

test("a Console that is down or refuses keeps the events for next time", async () => {
  addEvents(3, 10);
  assert.equal(await P.pushNewEvents(db, cfg, (async () => ({ ok: false, status: 503 })) as any), 0);
  assert.equal(await P.pushNewEvents(db, cfg, (async () => { throw new Error("down"); }) as any), 0);
  let n = 0;
  assert.equal(await P.pushNewEvents(db, cfg, (async (_u: string, i: any) => { n += JSON.parse(i.body).events.length; return { ok: true, status: 200 }; }) as any), 3);
  assert.equal(n, 3);
});

test("big backlogs go in batches of at most 500", async () => {
  addEvents(1200, 100);
  const sizes: number[] = [];
  const ok = (async (_u: string, i: any) => { sizes.push(JSON.parse(i.body).events.length); return { ok: true, status: 200 }; }) as any;
  assert.equal(await P.pushNewEvents(db, cfg, ok), 1200);
  assert.deepEqual(sizes, [500, 500, 200]);
});
