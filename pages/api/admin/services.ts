import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { q, exec } from "../../../lib/db";
import { ok, created, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";
import { readPaging, pageMeta } from "../../../lib/pagination";

// ==================================================================
// Catálogo de SERVICIOS (módulo "Servicios") -> /api/admin/services
//   GET            lista TODO el catálogo (nombre, descripción, icono y url)
//   POST           crea servicio { name, description?, icon?, url? }
//   PUT/PATCH      actualiza { id, ...campos }
//   DELETE         baja lógica (?id=N) — active = 0
//
// `url` es OPCIONAL: la liga base del Drive afiliada al servicio. Se puede
// definir aquí o directo desde la pestaña Servicios del paquete comprado
// del cliente (acción "actualizar-servicio-url" de package-progress).
// Requiere la migración 2026-10-13_services_url.sql (columna services.url).
// ==================================================================

const norm = (v: unknown) => (typeof v === "string" ? v.trim() : "");

type Row = {
  id: number;
  name: string | null;
  description: string | null;
  icon: string | null;
  url: string | null;
};

function map(r: Row) {
  return {
    id: Number(r.id),
    name: r.name || "",
    description: r.description || "",
    icon: r.icon || "",
    url: r.url || "",
  };
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  // Permiso por acción sobre el módulo "Servicios" (Admin pasa siempre).
  const ACTIONS: Record<string, "read" | "create" | "update" | "delete"> = {
    GET: "read",
    POST: "create",
    PUT: "update",
    PATCH: "update",
    DELETE: "delete",
  };
  const action = ACTIONS[req.method || ""];
  if (!action) {
    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
    return;
  }
  const me = await requirePermission(req, res, "Servicios", action);
  if (!me) return;

  try {
    if (req.method === "GET") {
      // PAGINADO EN EL SERVIDOR: ?page=1&limit=30 + buscador (`q`) y filtro
      // por liga de Drive (`link` = con | sin). La app recibe solo la página
      // y el total, no el catálogo entero.
      const p = readPaging(req);
      const search = norm(req.query.q);
      const linkFilter = norm(req.query.link).toLowerCase();

      const hasLink = "TRIM(COALESCE(url, '')) <> ''";
      const base: string[] = ["active = 1"];
      const baseParams: unknown[] = [];
      if (search) {
        base.push("(name LIKE ? OR description LIKE ?)");
        const like = `%${search}%`;
        baseParams.push(like, like);
      }
      const where = [...base];
      const params = [...baseParams];
      if (linkFilter === "con") where.push(hasLink);
      if (linkFilter === "sin") where.push(`NOT (${hasLink})`);
      const sqlWhere = where.join(" AND ");

      let facets: { con: number; all: number } = { con: 0, all: 0 };
      let rows: Row[];
      let total = 0;
      try {
        const facetRows = await q<{ con: number; all: number }>(
          `SELECT SUM(CASE WHEN ${hasLink} THEN 1 ELSE 0 END) AS con,
                  COUNT(*) AS \`all\`
             FROM services
            WHERE ${base.join(" AND ")}`,
          baseParams
        );
        facets = {
          con: Number(facetRows[0]?.con || 0),
          all: Number(facetRows[0]?.all || 0),
        };
        rows = await q<Row>(
          `SELECT id, name, description, icon, url
             FROM services
            WHERE ${sqlWhere}
            ORDER BY id ASC
            LIMIT ${p.limit} OFFSET ${p.offset}`,
          params
        );
        const countRows = await q<{ n: number }>(
          `SELECT COUNT(*) AS n FROM services WHERE ${sqlWhere}`,
          params
        );
        total = Number(countRows[0]?.n || 0);
      } catch {
        // Migración 2026-10-13_services_url.sql aún no aplicada: sin columna
        // `url` no hay liga que filtrar, así que se ignora ese filtro.
        const plainWhere = base.join(" AND ");
        rows = await q<Row>(
          `SELECT id, name, description, icon
             FROM services
            WHERE ${plainWhere}
            ORDER BY id ASC
            LIMIT ${p.limit} OFFSET ${p.offset}`,
          baseParams
        );
        const countRows = await q<{ n: number }>(
          `SELECT COUNT(*) AS n FROM services WHERE ${plainWhere}`,
          baseParams
        );
        total = Number(countRows[0]?.n || 0);
        facets = { con: 0, all: total };
      }
      res.status(200).json({
        services: rows.map(map),
        linkCounts: { with: facets.con, without: facets.all - facets.con, all: facets.all },
        ...pageMeta(total, p),
      });
      return;
    }

    if (req.method === "DELETE") {
      const id = Number(req.query.id || 0);
      if (!id) {
        fail(res, 400, "Falta el servicio", "Indica qué servicio quieres eliminar");
        return;
      }
      const r = await exec(`UPDATE services SET active = 0 WHERE id = ?`, [id]);
      if (!r.affectedRows) {
        fail(res, 404, "Servicio no encontrado", `No hay un servicio activo con id ${id}`);
        return;
      }
      await logActivity({
        userId: me.sub,
        module: "services",
        moduleName: "Servicios",
        action: "delete",
        entity: "servicio",
        entityId: id,
        description: "Servicio eliminado exitosamente",
        details: { id },
        req,
      });
      ok(res, "Servicio eliminado exitosamente", { item: { id } });
      return;
    }

    const b = (req.body || {}) as Record<string, unknown>;
    const name = norm(b.name);
    const description = norm(b.description);
    const icon = norm(b.icon);
    const url = norm(b.url);

    if (req.method === "POST") {
      if (!name) {
        fail(res, 400, "Escribe el nombre del servicio", "El nombre no puede ir vacío");
        return;
      }
      const r = await exec(
        `INSERT INTO services (name, description, icon, url)
         VALUES (?, ?, ?, ?)`,
        [name, description || null, icon || null, url || null]
      );
      const item = { id: Number(r.insertId), name, description, icon, url };
      await logActivity({
        userId: me.sub,
        module: "services",
        moduleName: "Servicios",
        action: "create",
        entity: "servicio",
        entityId: Number(r.insertId),
        description: "Servicio creado exitosamente",
        details: item,
        req,
      });
      created(res, "Servicio creado exitosamente", { item });
      return;
    }

    // ---- PUT / PATCH: actualiza solo los campos enviados ----
    const id = Number(b.id || 0);
    if (!id) {
      fail(res, 400, "Falta el servicio", "Indica qué servicio quieres modificar");
      return;
    }
    const fields: string[] = [];
    const params: unknown[] = [];
    if (b.name !== undefined) {
      if (!name) {
        fail(res, 400, "El nombre no puede ir vacío", "Escribe el nombre del servicio");
        return;
      }
      fields.push("`name` = ?");
      params.push(name);
    }
    if (b.description !== undefined) {
      fields.push("`description` = ?");
      params.push(description || null);
    }
    if (b.icon !== undefined) {
      fields.push("`icon` = ?");
      params.push(icon || null);
    }
    if (b.url !== undefined) {
      fields.push("`url` = ?");
      params.push(url || null);
    }
    if (!fields.length) {
      fail(res, 400, "Nada que actualizar", "No enviaste ningún campo del servicio");
      return;
    }
    const r = await exec(
      `UPDATE services SET ${fields.join(", ")} WHERE id = ?`,
      [...params, id]
    );
    if (!r.affectedRows) {
      fail(res, 404, "Servicio no encontrado", `No hay un servicio activo con id ${id}`);
      return;
    }
    const item = { id, name, description, icon, url };
    await logActivity({
      userId: me.sub,
      module: "services",
      moduleName: "Servicios",
      action: "update",
      entity: "servicio",
      entityId: id,
      description: "Servicio actualizado exitosamente",
      details: item,
      req,
    });
    ok(res, "Servicio actualizado exitosamente", { item });
    return;
  } catch (e) {
    console.error("[admin/services]", e);
    fail(res, 500, "Hubo un error", "No se pudo completar la operación del servicio");
  }
});
