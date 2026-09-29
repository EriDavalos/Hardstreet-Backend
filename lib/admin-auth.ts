// ==================================================================
// HARD STREET BACKEND - Guard de administración (rol Admin)
// ==================================================================
import type { NextApiRequest, NextApiResponse } from "next";
import { getSession } from "./auth";
import { q } from "./db";

/** Nombre del rol que puede administrar (coincide con roles.name = 'Admin'). */
export const ADMIN_ROLE = "Admin";

/** Rol fijo para el módulo de clientes (no se asigna: siempre "cliente"). */
export const CLIENT_ROLE = "Cliente";

/**
 * Valida sesión (header Bearer) + rol Admin en la BD.
 * Si no pasa, responde 401/403 y devuelve null.
 */
export async function requireAdmin(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<{ sub: number } | null> {
  const session = await getSession(req);
  if (!session) {
    res.status(401).json({ error: "No autenticado" });
    return null;
  }
  const rows = await q<{ id_role: number | null; role_name: string | null }>(
    `SELECT u.id_role, r.name AS role_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.id_role
      WHERE u.id = ? AND u.active = 1
      LIMIT 1`,
    [session.sub]
  );
  const role = rows[0];
  if (!role || String(role.role_name || "").toLowerCase() !== ADMIN_ROLE.toLowerCase()) {
    res.status(403).json({ error: "Solo administradores" });
    return null;
  }
  return { sub: session.sub };
}
