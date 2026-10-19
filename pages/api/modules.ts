import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../lib/cors";
import { getSession } from "../../lib/auth";
import { q } from "../../lib/db";

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  const session = await getSession(req);

  // Rol del usuario (0 = sin sesion: catálogo completo de módulos)
  let roleId = 0;
  if (session) {
    const u = await q<{ id_role: number | null }>(`SELECT id_role FROM users WHERE id = ?`, [
      session.sub,
    ]);
    roleId = Number(u[0]?.id_role || 0);
  }

  // Permisos por módulo en una sola pasada (GROUP_CONCAT en vez de ARRAY_AGG)
  const rows = await q<{
    id: number;
    mkey: string | null;
    name: string;
    description: string | null;
    url: string;
    order: number;
    categoryKey: string | null;
    categoryName: string | null;
    categoryOrder: number | null;
    perms: string | null;
  }>(
    `SELECT m.id, m.\`module\` AS mkey, m.name, m.description, m.url, m.\`order\`,
            mc.\`key\` AS categoryKey, mc.description AS categoryName,
            mc.\`order\` AS categoryOrder,
            GROUP_CONCAT(DISTINCT p.key ORDER BY p.key SEPARATOR ',') AS perms
       FROM modules m
       LEFT JOIN module_categories mc
              ON mc.id = m.id_module_category AND mc.active = 1
       LEFT JOIN permissions_roles pr ON pr.id_modules = m.id AND pr.active = 1
       LEFT JOIN permissions p ON p.id = pr.id_permission ${roleId ? "AND pr.id_role = ?" : ""}
      WHERE m.active = 1
      GROUP BY m.id, m.\`module\`, m.name, m.description, m.url, m.\`order\`,
               mc.\`key\`, mc.description, mc.\`order\`
      ORDER BY COALESCE(mc.\`order\`, 0) ASC, m.\`order\` ASC`,
    roleId ? [roleId] : []
  );

  res.status(200).json({
    modules: rows.map((m) => ({
      id: m.id,
      key: String(m.mkey || '').toLowerCase().trim(),
      name: m.name,
      description: m.description || '',
      url: m.url,
      order: m.order,
      categoryKey: m.categoryKey,
      categoryName: m.categoryName,
      categoryOrder: m.categoryOrder,
      permissions: (m.perms || "").split(",").filter(Boolean),
    })),
  });
});
