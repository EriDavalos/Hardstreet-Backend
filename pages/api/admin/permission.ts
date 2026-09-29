import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requireUser } from "../../../lib/auth";
import { q } from "../../../lib/db";
import { userRoleId, userIsAdmin } from "../../../lib/permissions";

// ==================================================================
// Permisos del usuario autenticado  ->  /api/admin/permission
//   GET  { isAdmin, modules: [{ name, actions: ["read","create",...] }] }
//
// Devuelve los MÓDULOS y ACCIONES reales del rol del usuario según
// permissions_roles. Para el rol Admin devuelve isAdmin=true y además la
// lista completa de módulos con todas sus acciones (el panel la usa para
// el menú; el backend SIEMPRE le autoriza todo vía requirePermission).
// ==================================================================

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Metodo no permitido" });
    return;
  }

  const session = await requireUser(req, res);
  if (!session) return;

  try {
    const roleId = await userRoleId(session.sub);
    if (!roleId) {
      res.status(401).json({ error: "Sesión inválida" });
      return;
    }

    // Filas de permissions_roles del rol, con nombre de módulo y acción.
    // Sirve para el usuario normal Y (solo lectura de módulos) para Admin.
    const rows = await q<{ name: string | null; key: string | null }>(
      `SELECT m.name, p.key
         FROM permissions_roles pr
         JOIN modules m     ON m.id = pr.id_modules  AND m.active = 1
         JOIN permissions p ON p.id = pr.id_permission AND p.active = 1
        WHERE pr.active = 1 AND pr.id_role = ?`,
      [roleId]
    );

    // Agrupa por módulo: { name: Set<acciones> }
    const byModule = new Map<string, Set<string>>();
    for (const r of rows) {
      const name = String(r.name || "").trim();
      const key = String(r.key || "").toLowerCase().trim();
      if (!name || !key) continue;
      if (!byModule.has(name)) byModule.set(name, new Set());
      byModule.get(name)!.add(key);
    }

    if (await userIsAdmin(roleId)) {
      res.status(200).json({
        isAdmin: true,
        modules: [...byModule.entries()].map(([name, actions]) => ({
          name,
          actions: [...actions],
        })),
      });
      return;
    }

    res.status(200).json({
      isAdmin: false,
      modules: [...byModule.entries()].map(([name, actions]) => ({
        name,
        actions: [...actions],
      })),
    });
  } catch (e) {
    console.error("[admin/permission]", e);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});
