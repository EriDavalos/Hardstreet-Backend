import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { getPackages } from "../../../lib/data";

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Metodo no permitido" });
    return;
  }

  const id = Number(req.query.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "ID invalido" });
    return;
  }

  const all = await getPackages();
  const pkg = all.find((p) => p.id === id);
  if (!pkg) {
    res.status(404).json({ error: "Paquete no encontrado" });
    return;
  }

  res.status(200).json({ package: pkg });
});
