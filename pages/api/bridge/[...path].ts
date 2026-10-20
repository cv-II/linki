import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { apolloLookup, BridgeError, configFromEnv, applyAccountLimits, enrolLeads, eraseLead, readEvents, setCampaignStatus, unenrolLead } from "@/lib/bridge";

/**
 * Careervira Console bridge. One catch-all route so the whole contract is in one place.
 *   POST   /api/bridge/campaigns/:id/members   { leads: [...] , campaign?: { name } }
 *   POST   /api/bridge/campaigns/:id/start | pause | stop
 *   DELETE /api/bridge/leads/:id
 *   POST   /api/bridge/enrich                  { id, name, company, linkedin_url }
 *   GET    /api/bridge/events?after=&limit=
 *   POST   /api/bridge/invites/withdraw        (not implemented yet: answers 501)
 * Auth is the existing x-internal-secret check in proxy.ts.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const parts = ([] as string[]).concat(req.query.path ?? []);
  const key = `${req.method} ${parts.length === 3 && parts[0] === "campaigns" ? `campaigns/:id/${parts[2]}` : parts.length === 2 && parts[0] === "leads" ? "leads/:id" : parts.length === 3 && parts[0] === "leads" && parts[2] === "erase" ? "leads/:id/erase" : parts.join("/")}`;
  try {
    const db = getDb();
    switch (key) {
      case "POST campaigns/:id/members": {
        const b = req.body ?? {};
        const out = enrolLeads(db, parts[1], b.leads, configFromEnv(), b.campaign ?? undefined);
        const c = db.prepare("SELECT account_id FROM bridge_campaigns WHERE external_id = ?").get(parts[1]) as { account_id: string } | undefined;
        if (c) applyAccountLimits(db, c.account_id);
        return res.json(out);
      }
      case "POST campaigns/:id/start": {
        const out = setCampaignStatus(db, parts[1], "start", req.body?.campaign ?? undefined);
        const { ensureGlobalRunnerStarted } = await import("@/lib/linkedin/runner");
        ensureGlobalRunnerStarted();
        return res.json(out);
      }
      case "POST campaigns/:id/pause": return res.json(setCampaignStatus(db, parts[1], "pause"));
      case "POST campaigns/:id/stop": return res.json(setCampaignStatus(db, parts[1], "stop"));
      case "DELETE leads/:id": return res.json(unenrolLead(db, parts[1]));
      case "DELETE leads/:id/erase": return res.json(eraseLead(db, parts[1]));
      case "GET events": {
        const limit = Number(req.query.limit ?? 200);
        return res.json(readEvents(db, typeof req.query.after === "string" ? req.query.after : null, limit));
      }
      case "POST enrich": {
        const row = db.prepare("SELECT api_key FROM integrations WHERE key = 'apollo'").get() as { api_key: string } | undefined;
        return res.json(await apolloLookup(row ? decryptSecret(row.api_key) : null, req.body ?? {}));
      }
      case "POST invites/withdraw":
        return res.status(501).json({ error: { code: "not_implemented", message: "Withdrawing LinkedIn invitations is not built into Linki yet." } });
      default:
        return res.status(404).json({ error: { code: "not_found", message: `No bridge route for ${key}` } });
    }
  } catch (e) {
    if (e instanceof BridgeError) return res.status(e.status).json({ error: { code: e.code, message: e.message } });
    console.error("[bridge]", e);
    return res.status(500).json({ error: { code: "internal", message: "Bridge error" } });
  }
}
