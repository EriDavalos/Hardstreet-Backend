import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../lib/cors";
import { getServices } from "../../lib/data";

export default withCors(async (_req: NextApiRequest, res: NextApiResponse) => {
  const services = await getServices();
  res.status(200).json({ services });
});
