import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../lib/cors";
import { getPackages } from "../../lib/data";

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Metodo no permitido" });
    return;
  }

  const externParam = req.query.extern;
  const category = typeof req.query.category === "string" ? req.query.category : undefined;

  const opts: { extern?: boolean; category?: string } = {};
  if (externParam === "true") opts.extern = true;
  if (externParam === "false") opts.extern = false;
  if (category && category !== "all") opts.category = category;

  const packages = await getPackages(opts);
  res.status(200).json({ packages });
});
