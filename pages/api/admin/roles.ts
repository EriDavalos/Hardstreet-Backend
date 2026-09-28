import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { q, exec, transaccion } from "../../../lib/db";
import { requirePermission } from "../../../lib/permissions";

// ==================================================================
// CRUD de roles + asignacion de permisos (solo rol Admin)
//   -> /api/admin/roles
//   GET     roles con sus permisos agrupados por modulo
//   POST    crea rol { name, permissions?: [{ moduleId, permissionIds: [] }] }
//   PUT     actualiza { id, name?, permissions? } (reemplaza el set completo)
//   DELETE  baja logica (?id=N) — active = 0 (tambia baja sus permisos)
// ==================================================================

export interface PermInput { moduleId: number; permissionIds: number[]; }

/** Inserta/actualiza el set de permisos de un rol dentro de una transaccion. */
async function savePermissions(
  conn: import("mysql2/promise").PoolConnection,
  roleId: number,
  permissions: PermInput[]
) {
  await conn.query(`UPDATE permissions_roles SET active = 0 WHERE id_role = ?`, [roleId]);
  for (const p of permissions) {
    if (!p.permissionIds?.length) continue;
    for (const pid of p.permissionIds) {
      // Reutiliza la fila existente (misma dupla modulo/permiso/rol) si hay una
      // inactiva, para no crecer la tabla sin fin con cada reasignacion.
      const [existing]: any[] = await conn.query(
        `SELECT id FROM permissions_roles
          WHERE id_role = ? AND id_modules = ? AND id_permission = ? LIMIT 1`,
        [roleId, p.moduleId, pid]
      );
      if ((existing as any[]).length) {
        await conn.query(`UPDATE permissions_roles SET active = 1 WHERE id = ?`, [
          (existing as any[])[0].id,
        ]);
      } else {
        await conn.query(
          `INSERT INTO permissions_roles (id_modules, id_permission, id_role) VALUES (?, ?, ?)`,
          [p.moduleId, pid, roleId]
        );
      }
    }
  }
}

/** Validaciones compartidas de nombre + formato de permisos. */
async function validateRole(
  res: NextApiResponse,
  b: Record<string, unknown>,
  opts: { withName: boolean; excludeId?: number }
): Promise<{ ok: boolean; name?: string; permissions?: PermInput[] }> {
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (opts.withName && !name) {
    res.status(400).json({ error: "El nombre del rol es obligatorio" });
    return { ok: false };
  }
  if (name) {
    const dup = await q(
      `SELECT id FROM roles WHERE LOWER(name) = ? AND active = 1 AND id <> ?`,
      [name.toLowerCase(), opts.excludeId || 0]
    );
    if (dup.length) {
      res.status(409).json({ error: "Ya existe un rol con ese nombre" });
      return { ok: false };
    }
  }
  let permissions: PermInput[] | undefined;
  if (Array.isArray(b.permissions)) {
    permissions = (b.permissions as any[])
      .map((p) => ({ moduleId: Number(p?.moduleId || 0), permissionIds: (p?.permissionIds || []).map(Number).filter(Boolean) }))
      .filter((p) => p.moduleId);
  }
  return { ok: true, name: name || undefined, permissions };
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  // Permiso por acción sobre el módulo "roles" (Admin pasa siempre).
  const ACTIONS: Record<string, "read" | "create" | "update" | "delete"> = {
    GET: "read",
    POST: "create",
    PUT: "update",
    PATCH: "update",
    DELETE: "delete",
  };
  const action = ACTIONS[req.method || ""];
  if (!action) {
    res.status(405).json({ error: "Metodo no permitido" });
    return;
  }
  if (!(await requirePermission(req, res, "roles", action))) return;

  try {
    switch (req.method) {
      case "GET": {
        const roles = await q<{ id: number; name: string | null }>(
          `SELECT id, name FROM roles WHERE active = 1 ORDER BY id ASC`
        );
        const perms = await q<{ id_role: number; id_modules: number; id_permission: number }>(
          `SELECT id_role, id_modules, id_permission
             FROM permissions_roles
            WHERE active = 1 AND id_role IN (SELECT id FROM roles WHERE active = 1)`
        );
        res.status(200).json({
          roles: roles.map((r) => ({
            id: r.id,
            name: r.name,
            permissions: perms
              .filter((p) => p.id_role === r.id)
              .map((p) => ({ moduleId: p.id_modules, permissionId: p.id_permission })),
          })),
        });
        return;
      }

      case "POST": {
        const b = (req.body || {}) as Record<string, unknown>;
        const v = await validateRole(res, b, { withName: true });
        if (!v.ok) return;
        const r = await exec(`INSERT INTO roles (name) VALUES (?)`, [v.name]);
        if (v.permissions?.length) {
          await transaccion((conn) => savePermissions(conn, r.insertId, v.permissions!));
        }
        res.status(201).json({ ok: true, id: r.insertId });
        return;
      }

      case "PUT":
      case "PATCH": {
        const b = (req.body || {}) as Record<string, unknown>;
        const id = Number(b.id || 0);
        if (!id) {
          res.status(400).json({ error: "Falta el id del rol" });
          return;
        }
        const v = await validateRole(res, b, { withName: false, excludeId: id });
        if (!v.ok) return;
        if (v.name !== undefined) {
          await exec(`UPDATE roles SET name = ? WHERE id = ?`, [v.name, id]);
        }
        if (v.permissions !== undefined) {
          await transaccion((conn) => savePermissions(conn, id, v.permissions!));
        }
        res.status(200).json({ ok: true });
        return;
      }

      case "DELETE": {
        const id = Number(req.query.id || 0);
        if (!id) {
          res.status(400).json({ error: "Falta el id del rol" });
          return;
        }
        const inUse = await q(`SELECT id FROM users WHERE id_role = ? AND active = 1 LIMIT 1`, [id]);
        if (inUse.length) {
          res.status(409).json({ error: "No se puede eliminar: hay usuarios con este rol" });
          return;
        }
        await transaccion(async (conn) => {
          await conn.query(`UPDATE permissions_roles SET active = 0 WHERE id_role = ?`, [id]);
          await conn.query(`UPDATE roles SET active = 0 WHERE id = ?`, [id]);
        });
        res.status(200).json({ ok: true });
        return;
      }

      default:
        res.status(405).json({ error: "Metodo no permitido" });
    }
  } catch (e) {
    console.error("[admin/roles]", e);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});
