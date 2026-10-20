// ==================================================================
// HARD STREET BACKEND - Bitácora de actividad  ->  /api/admin/activity
// ==================================================================
//   GET ?module=&action=&entity=&userId=&from=&to=&q=&limit=&offset=
//
// Devuelve las acciones registradas por `lib/activity.ts`: QUIÉN creó,
// editó o eliminó cada cosa, cuándo y desde dónde.
// Permiso: módulo "activity" (nombre "Actividad"), acción "read".
// ==================================================================
import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { q } from "../../../lib/db";
import { ok, fail } from "../../../lib/api-response";
import { requestScope, scopeFilterOn } from "../../../lib/company-scope";

const MAX_LIMIT = 200;

const norm = (v: unknown) => (typeof v === "string" ? v.trim() : "");

type Row = {
  id: number;
  id_user: number | null;
  user_name: string | null;
  role_name: string | null;
  module: string | null;
  module_name: string | null;
  action: string | null;
  entity: string | null;
  entity_id: number | null;
  description: string | null;
  details: string | null;
  ip: string | null;
  created: string | null;
};

function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function mapActivity(r: Row) {
  return {
    id: Number(r.id),
    userId: r.id_user === null ? null : Number(r.id_user),
    userName: String(r.user_name || ""),
    roleName: String(r.role_name || ""),
    module: String(r.module || ""),
    moduleName: String(r.module_name || ""),
    action: String(r.action || ""),
    entity: String(r.entity || ""),
    entityId: r.entity_id === null ? null : Number(r.entity_id),
    description: String(r.description || ""),
    details: safeParse(r.details),
    ip: String(r.ip || ""),
    created: String(r.created || ""),
  };
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
    return;
  }
  const me = await requirePermission(req, res, "activity", "read");
  if (!me) return;

  try {
    // Alcance por empresa: cada estudio ve SOLO su bitácora.
    const scope = await requestScope(req, me);
    const scopeSql = scopeFilterOn(scope, "a");

    // Condiciones BASE (buscador, usuario, fechas, entidad): las compartes el
    // listado y los conteos de los chips.
    const base: string[] = ["1 = 1", scopeSql.sql];
    const baseParams: unknown[] = [...scopeSql.params];

    const module = norm(req.query.module);
    const action = norm(req.query.action).toLowerCase();
    const entity = norm(req.query.entity);
    if (entity) {
      base.push("LOWER(a.entity) = LOWER(?)");
      baseParams.push(entity);
    }
    const userId = Number(req.query.userId || 0);
    if (userId) {
      base.push("a.id_user = ?");
      baseParams.push(userId);
    }
    const from = norm(req.query.from);
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      base.push("DATE(a.created) >= ?");
      baseParams.push(from);
    }
    const to = norm(req.query.to);
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      base.push("DATE(a.created) <= ?");
      baseParams.push(to);
    }
    const search = norm(req.query.q);
    if (search) {
      const like = `%${search}%`;
      base.push(
        "(a.description LIKE ? OR a.user_name LIKE ? OR a.entity LIKE ? OR a.module_name LIKE ?)"
      );
      baseParams.push(like, like, like, like);
    }

    const limit = Math.min(
      Math.max(Number(req.query.limit || 50) || 50, 1),
      MAX_LIMIT
    );
    // `page` manda; se conserva `offset` para clientes viejos.
    const rawPage = Math.max(Number(req.query.page || 0) || 0, 0);
    const offset = rawPage
      ? (rawPage - 1) * limit
      : Math.max(Number(req.query.offset || 0) || 0, 0);

    const where = [...base];
    const params = [...baseParams];
    if (module) {
      where.push("LOWER(a.`module`) = LOWER(?)");
      params.push(module);
    }
    if (action) {
      where.push("LOWER(a.`action`) = ?");
      params.push(action);
    }
    const sqlWhere = where.join(" AND ");

    const rows = await q<Row>(
      `SELECT a.id, a.id_user, a.user_name, a.role_name, a.\`module\`,
              a.module_name, a.\`action\`, a.entity, a.entity_id,
              a.description, a.details, a.ip,
              DATE_FORMAT(a.created, '%Y-%m-%dT%H:%i:%s') AS created
         FROM activity_log a
        WHERE ${sqlWhere}
        ORDER BY a.created DESC, a.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const countRows = await q<{ n: number }>(
      `SELECT COUNT(*) AS n FROM activity_log a WHERE ${sqlWhere}`,
      params
    );
    const total = Number(countRows[0]?.n || 0);

    // Conteos para los chips: por MÓDULO (sin aplicar el filtro de módulo) y
    // por ACCIÓN (sin aplicar el de acción). Así el panel no necesita bajar la
    // bitácora completa para pintar los contadores.
    const moduleRows = await q<{ name: string | null; n: number }>(
      `SELECT a.module_name AS name, COUNT(*) AS n
         FROM activity_log a
        WHERE ${base.join(" AND ")}
        GROUP BY a.module_name
        ORDER BY a.module_name ASC`,
      baseParams
    );
    const actionBase = [...base];
    const actionParams = [...baseParams];
    if (module) {
      actionBase.push("LOWER(a.`module`) = LOWER(?)");
      actionParams.push(module);
    }
    const actionRows = await q<{ name: string | null; n: number }>(
      `SELECT a.\`action\` AS name, COUNT(*) AS n
         FROM activity_log a
        WHERE ${actionBase.join(" AND ")}
        GROUP BY a.\`action\``,
      actionParams
    );
    const toMap = (list: { name: string | null; n: number }[]) => {
      const out: Record<string, number> = {};
      for (const r of list) {
        const key = (r.name || "").toString().trim();
        if (key) out[key] = Number(r.n || 0);
      }
      return out;
    };

    ok(res, "Bitácora cargada", {
      entries: rows.map(mapActivity),
      total,
      limit,
      offset,
      page: Math.floor(offset / limit) + 1,
      pages: Math.max(1, Math.ceil(total / limit)),
      moduleCounts: toMap(moduleRows),
      actionCounts: toMap(actionRows),
    });
  } catch (e) {
    console.error("[admin/activity]", e);
    fail(
      res,
      500,
      "Hubo un error",
      "No se pudo cargar la bitácora. ¿Aplicaste la migración 2026-10-16_activity_log.sql?"
    );
  }
});
