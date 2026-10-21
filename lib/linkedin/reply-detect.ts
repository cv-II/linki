import type DatabaseType from "better-sqlite3";

/**
 * LinkedIn reply detection, the pure part (no browser).
 *
 * The runner stops messaging a person once targets.last_replied_at is set, and the Console bridge turns that
 * column into a `linkedin_reply` event. In the open-core build nothing set it (the reader lived in a paid ee/ folder),
 * so this file and reply-sync.ts replace it.
 *
 * Input is whatever JSON LinkedIn's messaging page loads for the inbox (normalized "included" lists, where one object
 * points at another by id). The reader is deliberately tolerant: it does not depend on one exact response shape.
 * It looks for conversations, the people in them, and the messages each person wrote with a time. A message written by
 * a person who is one of our targets is, by definition, not ours, so we never need to know which side is "us".
 *
 * READ ONLY. Nothing here sends, opens a thread for writing or marks anything as read.
 */
type DB = DatabaseType.Database;
type Json = unknown;

export interface InboxMessage { fromUrn: string; at: number } // epoch ms
export interface InboxConversation { participantUrns: string[]; messages: InboxMessage[] }

const URN_RE = /urn:li:fsd_profile:[A-Za-z0-9_-]+/;

const isObj = (v: Json): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);

/** Index every object that has an entityUrn, so "*field": "urn" references can be followed. */
function buildIndex(payload: Json): Map<string, Record<string, Json>> {
  const idx = new Map<string, Record<string, Json>>();
  const visit = (v: Json, depth: number) => {
    if (depth > 12 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    const o = v as Record<string, Json>;
    if (typeof o.entityUrn === "string" && !idx.has(o.entityUrn)) idx.set(o.entityUrn, o);
    for (const x of Object.values(o)) visit(x, depth + 1);
  };
  visit(payload, 0);
  return idx;
}

export function extractConversations(payload: Json): InboxConversation[] {
  const idx = buildIndex(payload);
  const resolve = (v: Json): Json => (typeof v === "string" && idx.has(v) ? idx.get(v) : v);
  // A list may be an array, a { elements: [...] } wrapper, or a single reference.
  const list = (v: Json): Json[] => {
    const r = resolve(v);
    if (Array.isArray(r)) return r.map(resolve);
    if (isObj(r) && Array.isArray(r.elements)) return r.elements.map(resolve);
    if (isObj(r)) return [r];
    return [];
  };
  const field = (o: Record<string, Json>, name: string): Json => (o[name] !== undefined ? o[name] : o[`*${name}`]);
  const profileUrn = (v: Json): string | null => {
    const r = resolve(v);
    if (r === undefined || r === null) return null;
    const m = (typeof r === "string" ? r : JSON.stringify(r)).match(URN_RE);
    return m ? m[0] : null;
  };

  const out: InboxConversation[] = [];
  for (const o of idx.values()) {
    const type = typeof o.$type === "string" ? o.$type : "";
    if (!/Conversation$/.test(type) && field(o, "conversationParticipants") === undefined) continue;
    const participantUrns = list(field(o, "conversationParticipants")).map(profileUrn).filter((x): x is string => !!x);
    const messages: InboxMessage[] = [];
    for (const m of list(field(o, "messages"))) {
      if (!isObj(m)) continue;
      const at = typeof m.deliveredAt === "number" ? m.deliveredAt : typeof m.createdAt === "number" ? m.createdAt : null;
      const fromUrn = profileUrn(field(m, "sender"));
      if (at !== null && fromUrn) messages.push({ fromUrn, at });
    }
    if (participantUrns.length || messages.length) out.push({ participantUrns, messages });
  }
  return out;
}

const parseSqlTime = (s: string | null): number | null => {
  if (!s) return null;
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? null : d.getTime();
};
const toSql = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

/**
 * Marks people as replied. A reply is a message written by the person (matched on their messaging URN) that arrived after
 * we last messaged them. People already marked, or never messaged by us, are left alone. Safe to run any number of times.
 * Returns how many people were newly marked.
 */
export function applyReplies(db: DB, conversations: InboxConversation[]): number {
  const find = db.prepare("SELECT id, message_sent_at FROM targets WHERE messaging_urn = ? AND last_replied_at IS NULL");
  const mark = db.prepare("UPDATE targets SET last_replied_at = ? WHERE id = ? AND last_replied_at IS NULL");
  let marked = 0;
  db.transaction(() => {
    const done = new Set<string>();
    for (const c of conversations) {
      for (const m of c.messages) {
        const t = find.get(m.fromUrn) as { id: string; message_sent_at: string | null } | undefined;
        if (!t || done.has(t.id)) continue;
        const sentAt = parseSqlTime(t.message_sent_at);
        if (sentAt === null || m.at <= sentAt) continue; // we never messaged them, or this is older than our message
        // Use the earliest reply after our message, not the latest.
        const first = c.messages.filter((x) => x.fromUrn === m.fromUrn && x.at > sentAt).reduce((a, b) => (b.at < a ? b.at : a), m.at);
        if (mark.run(toSql(first), t.id).changes) { marked++; done.add(t.id); }
      }
    }
  })();
  return marked;
}
