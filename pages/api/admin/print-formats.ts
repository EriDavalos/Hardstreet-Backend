import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { ok, created, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";
import {
  deletePrintFormat,
  printFormats,
  savePrintFormat,
} from "../../../lib/print-requests";
import { requestScope } from "../../../lib/company-scope";

// ==================================================================
// FORMATOS DE IMPRESIÓN -> /api/admin/print-formats
//
//   GET                { formats: [{ id, name, width, height, unit }] }
//   POST { name, width, height, unit }  -> crea o actualiza el formato
//   DELETE ?id=N       -> baja lógica
//
// Los formatos son del ESTUDIO (no de un cliente): "12x18", "5x7", "1x1"…
// El nombre es la identidad visible; `width`/`height` fijan la proporción del
// recorte. `unit` es solo informativo (in | cm).
// ==================================================================

const asNumber = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method === "GET") {
    const session = await requirePermission(req, res, "print", "read");
    if (!session) return;
    try {
      // Alcance por empresa: cada estudio tiene sus formatos.
      const scope = await requestScope(req, session);
      ok(res, "Formatos", { formats: await printFormats(scope) });
    } catch (e) {
      console.error("[admin/print-formats] GET:", e);
      fail(res, 500, "No se pudieron cargar los formatos");
    }
    return;
  }

  if (req.method === "POST") {
    const session = await requirePermission(req, res, "print", "create");
    if (!session) return;
    const b = (req.body || {}) as Record<string, unknown>;
    try {
      const scope = await requestScope(req, session);
      const format = await savePrintFormat({
        name: String(b.name || ""),
        width: asNumber(b.width),
        height: asNumber(b.height),
        unit: String(b.unit || "in"),
        scope,
      });
      if (!format) {
        fail(res, 500, "No se pudo guardar el formato");
        return;
      }
      await logActivity({
        userId: session.sub,
        module: "print",
        action: "create",
        entity: "formato de impresión",
        entityId: format.id,
        description: `Formato de impresión ${format.name}`,
      });
      created(res, "Formato guardado", { item: format, format });
    } catch (e) {
      const status = Number((e as any)?.status) || 500;
      if (status >= 500) console.error("[admin/print-formats] POST:", e);
      fail(res, status, (e as Error)?.message || "No se pudo guardar");
    }
    return;
  }

  if (req.method === "DELETE") {
    const session = await requirePermission(req, res, "print", "delete");
    if (!session) return;
    const id = asNumber(req.query.id);
    if (!id) {
      fail(res, 400, "Indica el formato");
      return;
    }
    try {
      const scope = await requestScope(req, session);
      await deletePrintFormat(id, scope);
      await logActivity({
        userId: session.sub,
        module: "print",
        action: "delete",
        entity: "formato de impresión",
        entityId: id,
        description: `Eliminó el formato de impresión #${id}`,
      });
      ok(res, "Formato eliminado", { id });
    } catch (e) {
      console.error("[admin/print-formats] DELETE:", e);
      fail(res, 500, "No se pudo eliminar el formato");
    }
    return;
  }

  fail(res, 405, "Método no permitido");
});
