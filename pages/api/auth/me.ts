import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { getSession } from "../../../lib/auth";
import { q } from "../../../lib/db";
import { UserRow, RoleRow, mapUser } from "../../../lib/mappers";

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Metodo no permitido" });
    return;
  }

  const session = await getSession(req);
  if (!session) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  const rows = await q<
    UserRow & {
      role_name: string | null;
      id_company: number | null;
      company_name: string | null;
    }
  >(
    `SELECT u.id, u.name, u.lastname, u.number, u.email, u.id_role, u.id_company,
            r.name AS role_name, c.name AS company_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.id_role
       LEFT JOIN companies c ON c.id = u.id_company AND c.active = 1
      WHERE u.active = 1 AND u.id = ?
      LIMIT 1`,
    [session.sub]
  );
  const user = rows[0];
  if (!user) {
    res.status(401).json({ error: "Sesion invalida" });
    return;
  }

  const isSuperAdmin = String(user.role_name || "").toLowerCase() === "superadmin";

  res.status(200).json({
    user: {
      ...mapUser(user, { id: user.id_role || 0, name: user.role_name } as RoleRow),
      companyId: isSuperAdmin ? null : user.id_company ?? null,
      companyName: isSuperAdmin ? "" : user.company_name || "",
      isSuperAdmin,
    },
  });
});
