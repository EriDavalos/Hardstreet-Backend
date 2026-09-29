import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requireUser } from "../../../lib/auth";
import { q } from "../../../lib/db";
import { userRoleId, userIsAdmin } from "../../../lib/permissions";

// ==================================================================
// Permisos del usuario autenticado  ->  /api/admin/permission
//   GET  {
//     isAdmin,
//     modules: [{ key: "drive", name: "Archivos", actions: ["read",...] }]
//   }
//
// `key`  = columna modules.module (la CLAVE: home, drive, users, rols...)
// `name` = columna modules.name    (el nombre visible: Inicio, Archivos...)
// El panel registra AMBAS para identificar el módulo sin importar cuál use.
//
// Los permisos se leen de permissions_roles (activos) del rol del usuario,
// ADMIN INCLUIDO: si a su rol no le dieron "Ver" en un módulo, el panel lo
// oculta (el backend en sí sigue autorizando las acciones que sí tenga).
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

    const rows = await q<{
      module: string | null;
      name: string | null;
      key: string | null;
    }>(
      `SELECT m.\`module\` AS module, m.name, p.\`key\` AS key
         FROM permissions_roles pr
         JOIN modules m     ON m.id = pr.id_modules  AND m.active = 1
         JOIN permissions p ON p.id = pr.id_permission AND p.active = 1
        WHERE pr.active = 1 AND pr.id_role = ?`,
      [roleId]
    );

    // Agrupa por CLAVE (modules.module) en minúsculas para que la misma
    // dupla con varias filas no duplique módulos: { clave: { name, acciones } }
    const byModule = new Map<string, { name: string; actions: Set<string> }>();
    for (const r of rows) {
      const clave = String(r.module || "").toLowerCase().trim();
      const name = String(r.name || "").trim();
      const action = String(r.key || "").toLowerCase().trim();
      if (!clave || !name || !action) continue;
      if (!byModule.has(clave)) byModule.set(clave, { name, actions: new Set() });
      byModule.get(clave)!.actions.add(action);
    }

    const modules = [...byModule.entries()].map(([clave, v]) => ({
      key: clave,
      name: v.name,
      actions: [...v.actions],
    }));

    const isAdmin = await userIsAdmin(roleId);
    res.status(200).json({ isAdmin, modules });
  } catch (e) {
    console.error("[admin/permission]", e);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});
