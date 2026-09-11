import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requireUser } from "../../../lib/auth";
import { getGalleriesByUser } from "../../../lib/data";

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Metodo no permitido" });
    return;
  }

  const session = await requireUser(req, res);
  if (!session) return;

  const items = await getGalleriesByUser(session.sub);
  res.status(200).json({ gallery: items });
});
