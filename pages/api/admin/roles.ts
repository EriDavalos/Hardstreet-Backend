import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { q, exec, transaccion } from "../../../lib/db";
import {
  requirePermission,
  userIsSuperAdmin,
  userRoleId,
} from "../../../lib/permissions";
import { ok, created, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";
import { readPaging, pageMeta } from "../../../lib/pagination";
import { requestScope, scopeFilter } from "../../../lib/company-scope";

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
  // Id del permiso "Ver" (read): es la PUERTA del modulo. Regla de negocio:
  // si un modulo no recibe "Ver", no se concede NINGUNA otra accion de ese
  // modulo (create/update/delete/download). El front aplica lo mismo; aqui
  // se revalida para que la BD nunca quede inconsistente.
  const readRows = await q<{ id: number }>(
    `SELECT id FROM permissions WHERE LOWER(\`key\`) = 'read' AND active = 1 LIMIT 1`
  );
  const readId = readRows.length ? Number(readRows[0].id) : null;
  for (const p of permissions) {
    if (!p.permissionIds?.length) continue;
    if (readId !== null && !p.permissionIds.includes(readId)) continue;
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
  opts: { withName: boolean; excludeId?: number; companyId: number }
): Promise<{ ok: boolean; name?: string; permissions?: PermInput[] }> {
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (opts.withName && !name) {
    fail(res, 400, "El nombre del rol es obligatorio", "Escribe cómo se llamará el rol");
    return { ok: false };
  }
  if (name) {
    // El nombre puede repetirse ENTRE empresas (cada una tiene su Admin),
    // pero no dentro de la misma empresa.
    const dup = await q(
      `SELECT id FROM roles
        WHERE LOWER(name) = ? AND active = 1 AND id <> ? AND id_company = ?`,
      [name.toLowerCase(), opts.excludeId || 0, opts.companyId]
    );
    if (dup.length) {
      fail(res, 409, "Ya existe un rol con ese nombre", name);
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
    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
    return;
  }
  const me = await requirePermission(req, res, "roles", action);
  if (!me) return;

  // Alcance por empresa: cada estudio define sus propios roles.
  const scope = await requestScope(req, me);
  const scopeSql = scopeFilter(scope);
  const companyId = scope.writeCompanyId;

  // El rol Superadmin SOLO lo ve y lo toca el propio Superadministrador: un
  // Admin no puede crearlo, editarlo, borrarlo ni asignárselo a nadie.
  const isSuper = await userIsSuperAdmin(await userRoleId(me.sub));

  try {
    switch (req.method) {
      case "GET": {
        // Paginado: ?page=1&limit=30. Los permisos se piden SOLO de los roles
        // que van en esta página (antes se traían todos y se filtraban aquí).
        const p = readPaging(req);
        const hidden = isSuper ? "" : "AND LOWER(name) <> 'superadmin'";
        const countRows = await q<{ n: number }>(
          `SELECT COUNT(*) AS n FROM roles
            WHERE active = 1 ${hidden} AND ${scopeSql.sql}`,
          scopeSql.params
        );
        const roles = await q<{ id: number; name: string | null }>(
          `SELECT id, name FROM roles
            WHERE active = 1 ${hidden} AND ${scopeSql.sql} ORDER BY id ASC
            LIMIT ${p.limit} OFFSET ${p.offset}`,
          scopeSql.params
        );
        const ids = roles.map((r) => r.id);
        const perms = ids.length
          ? await q<{ id_role: number; id_modules: number; id_permission: number }>(
              `SELECT id_role, id_modules, id_permission
                 FROM permissions_roles
                WHERE active = 1 AND id_role IN (?)`,
              [ids]
            )
          : [];
        res.status(200).json({
          roles: roles.map((r) => ({
            id: r.id,
            name: r.name,
            permissions: perms
              .filter((p) => p.id_role === r.id)
              .map((p) => ({ moduleId: p.id_modules, permissionId: p.id_permission })),
          })),
          ...pageMeta(countRows[0]?.n, p),
        });
        return;
      }

      case "POST": {
        const b = (req.body || {}) as Record<string, unknown>;
        const v = await validateRole(res, b, { withName: true, companyId });
        if (!v.ok) return;
        if (String(v.name || "").toLowerCase() === "superadmin" && !isSuper) {
          fail(
            res,
            403,
            "Ese rol es del sistema",
            "Solo el Superadministrador administra su propio rol"
          );
          return;
        }
        const r = await exec(`INSERT INTO roles (name, id_company) VALUES (?, ?)`, [
          v.name,
          companyId,
        ]);
        if (v.permissions?.length) {
          await transaccion((conn) => savePermissions(conn, r.insertId, v.permissions!));
        }
        const item = { id: r.insertId, name: v.name };
        await logActivity({
          userId: me.sub,
          module: "rols",
          moduleName: "Roles",
          action: "create",
          entity: "rol",
          entityId: r.insertId,
          description: "Rol creado exitosamente",
          details: item,
          req,
        });
        created(res, "Rol creado exitosamente", { item });
        return;
      }

      case "PUT":
      case "PATCH": {
        const b = (req.body || {}) as Record<string, unknown>;
        const id = Number(b.id || 0);
        if (!id) {
          fail(res, 400, "Falta el id del rol", "Indica qué rol quieres modificar");
          return;
        }
        if (!isSuper) {
          const target = await q<{ name: string | null }>(
            "SELECT name FROM roles WHERE id = ? LIMIT 1",
            [id]
          );
          if (String(target[0]?.name || "").toLowerCase() === "superadmin") {
            fail(
              res,
              403,
              "Ese rol es del sistema",
              "Solo el Superadministrador administra su propio rol"
            );
            return;
          }
        }
        const v = await validateRole(res, b, { withName: false, excludeId: id, companyId });
        if (!v.ok) return;
        if (v.name !== undefined) {
          await exec(`UPDATE roles SET name = ? WHERE id = ? AND ${scopeSql.sql}`, [
            v.name,
            id,
            ...scopeSql.params,
          ]);
        }
        if (v.permissions !== undefined) {
          await transaccion((conn) => savePermissions(conn, id, v.permissions!));
        }
        const item = { id, name: v.name };
        await logActivity({
          userId: me.sub,
          module: "rols",
          moduleName: "Roles",
          action: "update",
          entity: "rol",
          entityId: id,
          description: "Rol actualizado exitosamente",
          details: {
            ...item,
            permissionsChanged: v.permissions !== undefined,
          },
          req,
        });
        ok(res, "Rol actualizado exitosamente", { item });
        return;
      }

      case "DELETE": {
        const id = Number(req.query.id || 0);
        if (!id) {
          fail(res, 400, "Falta el id del rol", "Indica qué rol quieres eliminar");
          return;
        }
        if (!isSuper) {
          const target = await q<{ name: string | null }>(
            "SELECT name FROM roles WHERE id = ? LIMIT 1",
            [id]
          );
          if (String(target[0]?.name || "").toLowerCase() === "superadmin") {
            fail(
              res,
              403,
              "Ese rol es del sistema",
              "Solo el Superadministrador administra su propio rol"
            );
            return;
          }
        }
        const inUse = await q(
          `SELECT id FROM users WHERE id_role = ? AND active = 1 AND id_company = ? LIMIT 1`,
          [id, companyId]
        );
        if (inUse.length) {
          fail(
            res,
            409,
            "No se puede eliminar: hay usuarios con este rol",
            "Reasigna a esos usuarios a otro rol primero"
          );
          return;
        }
        await transaccion(async (conn) => {
          await conn.query(`UPDATE permissions_roles SET active = 0 WHERE id_role = ?`, [id]);
          await conn.query(`UPDATE roles SET active = 0 WHERE id = ? AND ${scopeSql.sql}`, [
            id,
            ...scopeSql.params,
          ]);
        });
        await logActivity({
          userId: me.sub,
          module: "rols",
          moduleName: "Roles",
          action: "delete",
          entity: "rol",
          entityId: id,
          description: "Rol eliminado exitosamente",
          details: { id },
          req,
        });
        ok(res, "Rol eliminado exitosamente", { item: { id } });
        return;
      }

      default:
        fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
    }
  } catch (e) {
    console.error("[admin/roles]", e);
    fail(res, 500, "Hubo un error", "No se pudo completar la operación del rol");
  }
});
