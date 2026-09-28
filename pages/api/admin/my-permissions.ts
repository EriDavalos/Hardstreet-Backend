import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requireUser } from "../../../lib/auth";
import { q } from "../../../lib/db";
import { userRoleId, userIsAdmin } from "../../../lib/permissions";

// ==================================================================
// Mis permisos (usuario autenticado)  ->  /api/admin/my-permissions
//   GET  { isAdmin, modules: [{ name, actions: ["read","create",...] }] }
//
// El panel lo usa para mostrar SOLO los módulos donde el usuario tiene
// permiso de "Ver". Para el rol Admin devuelve isAdmin=true (acceso total).
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

    if (await userIsAdmin(roleId)) {
      res.status(200).json({ isAdmin: true, modules: [] });
      return;
    }

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

    res.status(200).json({
      isAdmin: false,
      modules: [...byModule.entries()].map(([name, actions]) => ({
        name,
        actions: [...actions],
      })),
    });
  } catch (e) {
    console.error("[admin/my-permissions]", e);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});
