import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { ok, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";
import {
  finishPrintRequest,
  printFormats,
  printRequests,
  reopenPrintRequest,
  savePrintRequestConfig,
} from "../../../lib/print-requests";

// ==================================================================
// IMPRESIONES -> /api/admin/print-requests
//
//   GET  { requests: [...], formats: [...] }
//        Cada envío: { id, serviceId, serviceName, packageName, clientId,
//                      clientName, status, formatId, formatName, border,
//                      sentAt, finishedAt, photos: ["ruta/foto.jpg", ...],
//                      crops: { "ruta/foto.jpg": { x, y, zoom, landscape } } }
//
//   POST { action: "save", requestId, formatId, border, crops }
//        GUARDA el formato, el borde y las posiciones SIN cerrar el envío:
//        se puede seguir ajustando y descargando después.
//   POST { action: "finish", requestId, formatId, border, crops? }
//        Cierra el envío con su formato, el grosor de borde (0-30 %) y las
//        posiciones de las fotos.
//   POST { action: "reopen", requestId }
//        Reabre el envío: el cliente vuelve a poder cambiar su selección.
//
// Permiso: módulo "print" (leer para GET; editar para las acciones).
// ==================================================================

const asNumber = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method === "GET") {
    const session = await requirePermission(req, res, "print", "read");
    if (!session) return;

    try {
      const [requests, formats] = await Promise.all([
        printRequests(),
        printFormats(),
      ]);
      ok(res, "Impresiones", { requests, formats });
    } catch (e) {
      console.error("[admin/print-requests] GET:", e);
      fail(res, 500, "No se pudieron cargar las impresiones");
    }
    return;
  }

  if (req.method !== "POST") {
    fail(res, 405, "Método no permitido");
    return;
  }

  const session = await requirePermission(req, res, "print", "update");
  if (!session) return;

  const body = (req.body || {}) as Record<string, unknown>;
  const action = String(body.action || "").trim().toLowerCase();
  const requestId = asNumber(body.requestId);

  if (!requestId) {
    fail(res, 400, "Indica el envío");
    return;
  }

  try {
    if (action === "save") {
      const saved = await savePrintRequestConfig({
        id: requestId,
        formatId: asNumber(body.formatId),
        border: asNumber(body.border),
        crops: body.crops,
      });
      await logActivity({
        userId: session.sub,
        module: "print",
        action: "update",
        entity: "impresion",
        entityId: requestId,
        description:
          `Guardó el formato del envío #${requestId} ` +
          `(${saved.crops} posiciones)`,
      });
      ok(res, "Configuración guardada", {
        done: true,
        ...saved,
        details:
          `${saved.crops} ` +
          `${saved.crops === 1 ? "posición guardada" : "posiciones guardadas"}`,
      });
      return;
    }

    if (action === "finish") {
      const formatId = asNumber(body.formatId);
      if (!formatId) {
        fail(res, 400, "Elige el formato de impresión");
        return;
      }
      await finishPrintRequest({
        id: requestId,
        formatId,
        border: asNumber(body.border),
        crops: body.crops,
      });
      await logActivity({
        userId: session.sub,
        module: "print",
        action: "update",
        entity: "impresion",
        entityId: requestId,
        description: `Cerró el envío de impresión #${requestId}`,
      });
      ok(res, "Envío cerrado", { done: true });
      return;
    }

    if (action === "reopen") {
      const serviceId = await reopenPrintRequest(requestId);
      await logActivity({
        userId: session.sub,
        module: "print",
        action: "update",
        entity: "impresion",
        entityId: requestId,
        description:
          `Reabrió el envío de impresión #${requestId}` +
          (serviceId ? ` (servicio ${serviceId})` : ""),
      });
      ok(res, "Envío reabierto", { done: true, serviceId });
      return;
    }

    fail(res, 400, `Acción desconocida: ${action || "(vacía)"}`);
  } catch (e) {
    console.error("[admin/print-requests] POST:", e);
    const status = Number((e as any)?.status) || 500;
    fail(res, status, (e as Error)?.message || "No se pudo completar");
  }
});
