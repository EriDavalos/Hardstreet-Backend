import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../lib/cors";
import { getCategories } from "../../lib/data";

export default withCors(async (_req: NextApiRequest, res: NextApiResponse) => {
  const categories = await getCategories();
  res.status(200).json({ categories });
});
