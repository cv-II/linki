// Careervira bridge: the Console asks this to know Linki is up. Needs the internal secret or a signed-in session like every other API route.
import type { NextApiRequest, NextApiResponse } from "next";
import { getDb } from "@/lib/db";

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  try {
    getDb().prepare("SELECT 1").get();
    res.status(200).json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "database unavailable" });
  }
}
