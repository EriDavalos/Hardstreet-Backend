import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requireUser } from "../../../lib/auth";
import { q } from "../../../lib/db";
import { notifyPrintRequest } from "../../../lib/admin-notifications";
import { userIsAdmin, userRoleId } from "../../../lib/permissions";
import { userCompanyId } from "../../../lib/companies";
import { serviceShare } from "../../../lib/service-shares";
import {
  createPrintRequest,
  servicePrintRequest,
  serviceSelection,
  userOwnsService,
} from "../../../lib/print-requests";

// ==================================================================
// ENVIAR A IMPRESIÓN -> /api/my/print-requests  (cliente)
//
//   GET  ?serviceId=N
//        { serviceId, requestId, status, formatName, border,
//          photos: [...], canEdit }
//        `status` = "" (sin enviar) | sent | finished
//
//   POST { serviceId }
//        Copia la selección actual del servicio al envío y la BLOQUEA.
//        Si ya hay un envío activo responde 409 (hay que reabrirlo desde el
//        módulo de impresiones).
//
// El cliente necesita «Elegir fotos» encendido y al menos una foto elegida.
// ==================================================================

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  const session = await requireUser(req, res);
  if (!session) return;

  try {
    const roleId = await userRoleId(session.sub);
    const isAdmin = await userIsAdmin(roleId);

    if (req.method === "GET") {
      const serviceId = Number(req.query.serviceId || 0);
      if (!serviceId) {
        res.status(400).json({ error: "Indica el servicio del paquete" });
        return;
      }
      if (!(await userOwnsService(session.sub, serviceId, isAdmin))) {
        res.status(404).json({ error: "Ese servicio no pertenece a tus paquetes" });
        return;
      }
      const request = await servicePrintRequest(serviceId);
      const photos = request ? await sentPhotos(request.id) : [];
      let formatName = "";
      if (request?.formatId) {
        const rows = await q<{ name: string | null }>(
          `SELECT name FROM print_formats WHERE id = ? LIMIT 1`,
          [request.formatId]
        );
        formatName = String(rows[0]?.name || "").trim();
      }
      res.status(200).json({
        serviceId,
        requestId: request?.id ?? null,
        status: request?.status ?? "",
        formatName,
        border: request?.border ?? 0,
        photos,
        // Mientras el envío esté activo, el cliente NO puede cambiar la
        // selección: solo verla.
        canEdit: !request,
      });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Metodo no permitido" });
      return;
    }

    const b = (req.body || {}) as Record<string, unknown>;
    const serviceId = Number(b.serviceId || 0);
    if (!serviceId) {
      res.status(400).json({ error: "Indica el servicio del paquete" });
      return;
    }
    if (!(await userOwnsService(session.sub, serviceId, isAdmin))) {
      res.status(404).json({ error: "Ese servicio no pertenece a tus paquetes" });
      return;
    }

    const share = await serviceShare(serviceId);
    if (!share.pickPhotos) {
      res.status(400).json({
        error: "Elegir fotos no está disponible para este servicio",
      });
      return;
    }

    const existing = await servicePrintRequest(serviceId);
    if (existing) {
      res.status(409).json({
        error:
          existing.status === "finished"
            ? "Estas fotos ya se imprimieron. Pídele al estudio que reabra el envío."
            : "Ya enviaste estas fotos a impresión. Pídele al estudio que reabra el envío para cambiarlas.",
      });
      return;
    }

    const photos = await serviceSelection(serviceId);
    if (!photos.length) {
      res.status(400).json({ error: "Elige al menos una foto antes de enviar" });
      return;
    }

    const companyId = (await userCompanyId(session.sub)) ?? undefined;
    const requestId = await createPrintRequest({
      serviceId,
      userId: session.sub,
      paths: photos,
      companyId,
    });
    // El equipo (los roles que el módulo Notificaciones elija para «envío de
    // fotos seleccionadas») recibe el aviso en su campanita. Si falla, el
    // envío ya quedó hecho.
    await notifyTeam(
      requestId,
      serviceId,
      session.sub,
      photos.length,
      companyId ?? null
    );
    res.status(200).json({
      serviceId,
      requestId,
      status: "sent",
      photos,
      canEdit: false,
    });
  } catch (e) {
    console.error("[my/print-requests]", e);
    const status = Number((e as any)?.status) || 500;
    res
      .status(status)
      .json({ error: (e as Error)?.message || "Error interno del servidor" });
  }
});

/** Avisa al equipo del envío (nunca rompe la respuesta al cliente). */
async function notifyTeam(
  requestId: number,
  serviceId: number,
  userId: number,
  photos: number,
  companyId: number | null = null
): Promise<void> {
  try {
    const rows = await q<{
      serviceName: string | null;
      packageName: string | null;
      clientName: string | null;
    }>(
      `SELECT s.name AS serviceName,
              pp.name AS packageName,
              TRIM(CONCAT(COALESCE(u.name, ''), ' ', COALESCE(u.lastname, '')))
                AS clientName
         FROM purchased_packages_services pps
         JOIN purchased_packages pp ON pp.id = pps.id_purchased_package
         LEFT JOIN services s ON s.id = pps.id_service
         LEFT JOIN users u ON u.id = ?
        WHERE pps.id = ?
        LIMIT 1`,
      [userId, serviceId]
    );
    const r = rows[0];
    await notifyPrintRequest({
      requestId,
      serviceId,
      clientName: String(r?.clientName || "").trim(),
      serviceName: String(r?.serviceName || "").trim(),
      packageName: String(r?.packageName || "").trim(),
      photos,
      companyId,
    });
  } catch (e) {
    console.error("[my/print-requests notify]", e);
  }
}

/** Fotos del envío (solo lectura para el cliente). */
async function sentPhotos(requestId: number): Promise<string[]> {
  try {
    const rows = await q<{ path: string | null }>(
      `SELECT path FROM print_requests_items
        WHERE active = 1 AND id_print_request = ?
        ORDER BY id ASC`,
      [requestId]
    );
    return rows.map((r) => String(r.path || "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}
