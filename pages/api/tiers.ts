import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../lib/cors";
import { getTiers } from "../../lib/data";

export default withCors(async (_req: NextApiRequest, res: NextApiResponse) => {
  const tiers = await getTiers();
  res.status(200).json({ tiers });
});
