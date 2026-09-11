import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../lib/cors";
import { pool } from "../../lib/db";

export default withCors(async (_req: NextApiRequest, res: NextApiResponse) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ ok: true, db: "up", time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, db: "down", error: (e as Error).message });
  }
});
