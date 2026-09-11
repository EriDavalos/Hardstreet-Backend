import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { getPublicGalleries } from "../../../lib/data";

export default withCors(async (_req: NextApiRequest, res: NextApiResponse) => {
  const items = await getPublicGalleries();
  res.status(200).json({ gallery: items });
});
