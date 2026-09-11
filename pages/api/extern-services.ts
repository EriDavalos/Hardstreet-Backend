import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../lib/cors";
import { getPackages, getServices } from "../../lib/data";

export default withCors(async (_req: NextApiRequest, res: NextApiResponse) => {
  // Servicios externos destacados: usamos paquetes con is_extern = 1
  const packages = await getPackages({ extern: true });
  if (packages.length > 0) {
    res.status(200).json({ externServices: packages });
    return;
  }
  // Fallback: si aun no hay paquetes externos, devuelve el catalogo de servicios
  const services = await getServices();
  res.status(200).json({ externServices: [], services });
});
