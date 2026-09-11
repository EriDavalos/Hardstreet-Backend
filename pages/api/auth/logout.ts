import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { clearSessionCookie } from "../../../lib/auth";

export default withCors(async (_req: NextApiRequest, res: NextApiResponse) => {
  clearSessionCookie(res);
  res.status(200).json({ ok: true });
});
