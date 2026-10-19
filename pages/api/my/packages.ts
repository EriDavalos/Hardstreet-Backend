import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requireUser } from "../../../lib/auth";
import { getPurchasedPackagesByUser } from "../../../lib/data";
import { servicePrintStates } from "../../../lib/print-requests";

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Metodo no permitido" });
    return;
  }

  const session = await requireUser(req, res);
  if (!session) return;

  const purchased = await getPurchasedPackagesByUser(session.sub);

  // Estado de IMPRESIÓN de cada servicio del paquete.
  //
  // Sin esto el cliente seguía viendo «Enviar a impresión» después de enviar
  // (la app solo puede ocultarlo si sabe que el envío ya existe). Se consulta
  // en UNA sola petición y sin la migración de impresiones queda vacío.
  const serviceIds: number[] = [];
  for (const p of purchased as any[]) {
    for (const s of (p?.services ?? []) as any[]) {
      const id = Number(s?.id ?? 0);
      if (id > 0) serviceIds.push(id);
    }
  }
  const states = await servicePrintStates(serviceIds);

  for (const p of purchased as any[]) {
    for (const s of (p?.services ?? []) as any[]) {
      const state = states.get(Number(s?.id ?? 0));
      s.printStatus = state?.status ?? "";
      s.sentToPrint = Boolean(state);
      s.printRequestId = state?.id ?? null;
    }
  }

  res.status(200).json({ purchasedPackages: purchased });
});
