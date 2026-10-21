import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { ok, fail } from "../../../lib/api-response";
import { q, exec } from "../../../lib/db";
import { logActivity } from "../../../lib/activity";
import { requestScope, scopeFilter } from "../../../lib/company-scope";

// ==================================================================
// UBICACIONES GUARDADAS -> /api/admin/locations
//
//   GET    { locations: [{ id, name, address, lat, lng }] }
//   POST   { name, address?, lat, lng }  -> guarda (o actualiza) un lugar
//   DELETE ?id=N                         -> deja de ofrecerse
//
// Son los lugares que el estudio reutiliza al agendar: se eligen de la lista
// en el selector de lugar en vez de buscarlos otra vez en el mapa. Cada
// empresa ve SOLO las suyas.
//
// Permiso: el mismo módulo de Agendas (Ver para leer; Crear/Eliminar para
// administrarlas). Sin la migración aplicada la lectura devuelve [].
// ==================================================================

type LocationRow = {
  id: number;
  name: string | null;
  address: string | null;
  lat: number | string | null;
  lng: number | string | null;
};

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const text = (v: unknown, max: number) =>
  String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method === "GET") {
    const session = await requirePermission(req, res, "schedules", "read");
    if (!session) return;
    try {
      const scope = await requestScope(req, session);
      const f = scopeFilter(scope);
      const rows = await q<LocationRow>(
        `SELECT id, name, address, lat, lng
           FROM locations
          WHERE active = 1 AND ${f.sql}
          ORDER BY name ASC`,
        f.params
      );
      ok(res, "Ubicaciones", {
        locations: rows.map((r) => ({
          id: Number(r.id),
          name: String(r.name || ""),
          address: String(r.address || ""),
          lat: num(r.lat),
          lng: num(r.lng),
        })),
      });
    } catch (e) {
      console.error("[admin/locations] GET:", e);
      // Migración pendiente: el selector funciona sin la lista guardada.
      ok(res, "Ubicaciones", { locations: [] });
    }
    return;
  }

  if (req.method === "POST") {
    const session = await requirePermission(req, res, "schedules", "create");
    if (!session) return;
    const body = (req.body || {}) as Record<string, unknown>;
    const name = text(body.name, 160);
    const address = text(body.address, 300);
    const lat = num(body.lat);
    const lng = num(body.lng);
    if (!name) {
      fail(res, 400, "Escribe el nombre del lugar", "El lugar necesita nombre");
      return;
    }
    if (lat === null || lng === null) {
      fail(
        res,
        400,
        "Marca el lugar en el mapa",
        "El lugar necesita un punto (latitud y longitud)"
      );
      return;
    }
    const scope = await requestScope(req, session);
    try {
      // ¿Ya existe con ese nombre? Se actualiza en vez de duplicarlo.
      const existing = await q<{ id: number }>(
        `SELECT id FROM locations
          WHERE active = 1 AND LOWER(name) = LOWER(?) AND id_company = ?
          LIMIT 1`,
        [name, scope.writeCompanyId]
      );
      let id = Number(existing[0]?.id ?? 0);
      if (id > 0) {
        await exec(
          `UPDATE locations SET address = ?, lat = ?, lng = ? WHERE id = ?`,
          [address || null, lat, lng, id]
        );
      } else {
        const r = await exec(
          `INSERT INTO locations
             (id_company, name, address, lat, lng, active)
           VALUES (?, ?, ?, ?, ?, 1)`,
          [scope.writeCompanyId, name, address || null, lat, lng]
        );
        id = r.insertId;
      }
      await logActivity({
        userId: session.sub,
        module: "schedules",
        moduleName: "Agendas",
        action: "create",
        entity: "ubicacion",
        entityId: id || null,
        description: `Guardó la ubicación «${name}»`,
        companyId: scope.writeCompanyId,
      });
      ok(res, "Ubicación guardada", {
        item: { id, name, address, lat, lng },
        locations: await listLocations(scope.companyId ?? scope.writeCompanyId),
      });
    } catch (e) {
      console.error("[admin/locations] POST:", e);
      fail(
        res,
        500,
        "No se pudo guardar la ubicación",
        "Aplica la migración 2026-10-20_notificaciones_ubicaciones.sql"
      );
    }
    return;
  }

  if (req.method === "DELETE") {
    const session = await requirePermission(req, res, "schedules", "delete");
    if (!session) return;
    const id = Number(req.query.id || 0);
    if (!id) {
      fail(res, 400, "Indica la ubicación a quitar");
      return;
    }
    const scope = await requestScope(req, session);
    const f = scopeFilter(scope);
    try {
      const r = await exec(
        `UPDATE locations SET active = 0 WHERE id = ? AND ${f.sql}`,
        [id, ...f.params]
      );
      if (!r.affectedRows) {
        fail(res, 404, "Esa ubicación ya no existe");
        return;
      }
      await logActivity({
        userId: session.sub,
        module: "schedules",
        moduleName: "Agendas",
        action: "delete",
        entity: "ubicacion",
        entityId: id,
        description: "Quitó una ubicación guardada",
        companyId: scope.writeCompanyId,
      });
      ok(res, "Ubicación quitada", {
        locations: await listLocations(scope.companyId ?? scope.writeCompanyId),
      });
    } catch (e) {
      console.error("[admin/locations] DELETE:", e);
      fail(res, 500, "No se pudo quitar la ubicación");
    }
    return;
  }

  fail(res, 405, "Método no permitido");
});

/** Lista activa de una empresa (o de todas si no se indica). */
async function listLocations(companyId: number | null): Promise<
  { id: number; name: string; address: string; lat: number | null; lng: number | null }[]
> {
  try {
    const rows = await q<LocationRow>(
      `SELECT id, name, address, lat, lng
         FROM locations
        WHERE active = 1 ${companyId ? "AND id_company = ?" : ""}
        ORDER BY name ASC`,
      companyId ? [companyId] : []
    );
    return rows.map((r) => ({
      id: Number(r.id),
      name: String(r.name || ""),
      address: String(r.address || ""),
      lat: num(r.lat),
      lng: num(r.lng),
    }));
  } catch {
    return [];
  }
}
