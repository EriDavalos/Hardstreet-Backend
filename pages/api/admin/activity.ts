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
  if (!(await requirePermission(req, res, "activity", "read"))) return;

  try {
    const where: string[] = ["1 = 1"];
    const params: unknown[] = [];

    const module = norm(req.query.module);
    if (module) {
      where.push("LOWER(a.`module`) = LOWER(?)");
      params.push(module);
    }
    const action = norm(req.query.action).toLowerCase();
    if (action) {
      where.push("LOWER(a.`action`) = ?");
      params.push(action);
    }
    const entity = norm(req.query.entity);
    if (entity) {
      where.push("LOWER(a.entity) = LOWER(?)");
      params.push(entity);
    }
    const userId = Number(req.query.userId || 0);
    if (userId) {
      where.push("a.id_user = ?");
      params.push(userId);
    }
    const from = norm(req.query.from);
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      where.push("DATE(a.created) >= ?");
      params.push(from);
    }
    const to = norm(req.query.to);
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      where.push("DATE(a.created) <= ?");
      params.push(to);
    }
    const search = norm(req.query.q);
    if (search) {
      const like = `%${search}%`;
      where.push(
        "(a.description LIKE ? OR a.user_name LIKE ? OR a.entity LIKE ? OR a.module_name LIKE ?)"
      );
      params.push(like, like, like, like);
    }

    const limit = Math.min(
      Math.max(Number(req.query.limit || 50) || 50, 1),
      MAX_LIMIT
    );
    const offset = Math.max(Number(req.query.offset || 0) || 0, 0);
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

    ok(res, "Bitácora cargada", {
      entries: rows.map(mapActivity),
      total: Number(countRows[0]?.n || 0),
      limit,
      offset,
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
