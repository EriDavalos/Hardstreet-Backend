// ==================================================================
// HARD STREET BACKEND - Permisos por módulo y acción (BD)
// ==================================================================
// La app manda su token en `Authorization: Bearer <token>` (o `Apikey`).
// Cada endpoint declara qué módulo protege y qué acción exige:
//   await requirePermission(req, res, "users", "update")
// El permiso se lee de la tabla `permissions_roles`:
//   (id_role, id_module, id_permission, active)
// y `permissions.key` define la acción: read/create/update/delete/download.
// El rol "Admin" pasa SIEMPRE (acceso total) para no romper el panel actual.
// ==================================================================

import type { NextApiRequest, NextApiResponse } from "next";
import { getSession } from "./auth";
import { q } from "./db";

export const ADMIN_ROLE = "Admin";

export type PermissionAction =
  | "read"
  | "create"
  | "update"
  | "delete"
  | "download";

/** ¿El rol dado puede ejecutar [action] sobre el módulo [module]? */
export async function roleCan(
  roleId: number,
  module: string,
  action: PermissionAction
): Promise<boolean> {
  const rows = await q<{ ok: number }>(
    `SELECT 1 AS ok
       FROM permissions_roles pr
       JOIN permissions p ON p.id = pr.id_permission AND p.active = 1
       JOIN modules m     ON m.id = pr.id_modules  AND m.active = 1
       JOIN roles r       ON r.id = pr.id_role     AND r.active = 1
      WHERE pr.active = 1
        AND pr.id_role = ?
        AND LOWER(m.name) = LOWER(?)
        AND LOWER(p.key) = LOWER(?)
      LIMIT 1`,
    [roleId, module, action]
  );
  return rows.length > 0;
}

/** Id del rol de un usuario activo (o null si no existe). */
export async function userRoleId(userId: number): Promise<number | null> {
  const rows = await q<{ id_role: number | null }>(
    `SELECT id_role FROM users WHERE id = ? AND active = 1 LIMIT 1`,
    [userId]
  );
  return rows[0]?.id_role ?? null;
}

/** ¿Es administrador (rol Admin)? */
export async function userIsAdmin(roleId: number | null): Promise<boolean> {
  if (!roleId) return false;
  const rows = await q<{ id: number }>(
    `SELECT id FROM roles WHERE id = ? AND LOWER(name) = ? AND active = 1 LIMIT 1`,
    [roleId, ADMIN_ROLE.toLowerCase()]
  );
  return rows.length > 0;
}

/**
 * Valida sesión + permiso concreto (módulo/acción).
 * Acepta el token en `Authorization: Bearer <token>` o en `Apikey: <token>`.
 * Si no pasa, responde 401/403 y devuelve null (el handler debe cortar).
 */
export async function requirePermission(
  req: NextApiRequest,
  res: NextApiResponse,
  module: string,
  action: PermissionAction
): Promise<{ sub: number; role: string } | null> {
  // El header Apikey también lleva el JWT de sesión (lo manda la app).
  const apikey = req.headers["apikey"];
  if (apikey && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${String(apikey).trim()}`;
  }

  const session = await getSession(req);
  if (!session) {
    res.status(401).json({ error: "No autenticado" });
    return null;
  }

  const roleId = await userRoleId(session.sub);
  if (!roleId) {
    res.status(401).json({ error: "Sesión inválida" });
    return null;
  }

  if (await userIsAdmin(roleId)) {
    return { sub: session.sub, role: ADMIN_ROLE };
  }

  if (!(await roleCan(roleId, module, action))) {
    res.status(403).json({
      error: "No tienes permiso para realizar esta acción",
      module,
      action,
    });
    return null;
  }

  return { sub: session.sub, role: session.role };
}

/**
 * Igual que [requirePermission] pero solo exige que el usuario exista y
 * tenga AL MENOS un permiso sobre el módulo (para "ver el módulo").
 */
export async function requireAnyPermission(
  req: NextApiRequest,
  res: NextApiResponse,
  module: string
): Promise<{ sub: number; role: string } | null> {
  const apikey = req.headers["apikey"];
  if (apikey && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${String(apikey).trim()}`;
  }

  const session = await getSession(req);
  if (!session) {
    res.status(401).json({ error: "No autenticado" });
    return null;
  }

  const roleId = await userRoleId(session.sub);
  if (!roleId) {
    res.status(401).json({ error: "Sesión inválida" });
    return null;
  }

  if (await userIsAdmin(roleId)) {
    return { sub: session.sub, role: ADMIN_ROLE };
  }

  const rows = await q<{ ok: number }>(
    `SELECT 1 AS ok
       FROM permissions_roles pr
       JOIN modules m ON m.id = pr.id_modules AND m.active = 1
      WHERE pr.active = 1 AND pr.id_role = ? AND LOWER(m.name) = LOWER(?)
      LIMIT 1`,
    [roleId, module]
  );
  if (!rows.length) {
    res.status(403).json({ error: "No tienes acceso a este módulo", module });
    return null;
  }
  return { sub: session.sub, role: session.role };
}
