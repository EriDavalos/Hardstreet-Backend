import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../lib/cors";
import { getSession } from "../../lib/auth";
import { q } from "../../lib/db";

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  const session = await getSession(req);

  let rows: any[] = [];
  if (session) {
    // Modulos permitidos para el rol del usuario
    rows = await q(
      `SELECT DISTINCT m.id, m.name, m.url, m."order",
              ARRAY_AGG(DISTINCT p.key) AS permissions
         FROM modules m
         JOIN permissions_roles pr ON pr.id_modules = m.id AND pr.active = 1
         JOIN roles r ON r.id = pr.id_role
         LEFT JOIN permissions p ON p.id = pr.id_permission
        WHERE m.active = 1 AND r.id = $1
        GROUP BY m.id, m.name, m.url, m."order"
        ORDER BY m."order" ASC`,
      [session.sub ? (await q(`SELECT id_role FROM users WHERE id = $1`, [session.sub]))[0]?.id_role : 0]
    );
  } else {
    rows = await q(
      `SELECT m.id, m.name, m.url, m."order", ARRAY_AGG(DISTINCT p.key) AS permissions
         FROM modules m
         JOIN permissions_roles pr ON pr.id_modules = m.id AND pr.active = 1
         LEFT JOIN permissions p ON p.id = pr.id_permission
        WHERE m.active = 1
        GROUP BY m.id, m.name, m.url, m."order"
        ORDER BY m."order" ASC`
    );
  }

  res.status(200).json({
    modules: rows.map((m) => ({
      id: m.id,
      name: m.name,
      url: m.url,
      order: m.order,
      permissions: (m.permissions || []).filter(Boolean),
    })),
  });
});
