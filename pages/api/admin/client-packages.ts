import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requireAdmin } from "../../../lib/admin-auth";
import { q, exec, transaccion } from "../../../lib/db";

// ==================================================================
// Paquetes de un cliente (solo rol Admin)  ->  /api/admin/client-packages
//   GET  ?userId=N        purchased_packages del cliente + catalogo para asignar
//   POST { userId, purchasedPackageId }   -> asigna (users_packages)
//   POST { userId, usersPackageId }       -> quita (baja logica del vinculo)
//   POST { userId, packageId, price?, paid? } -> crea compra nueva desde catalogo
// ==================================================================

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (!(await requireAdmin(req, res))) return;

  try {
    if (req.method === "GET") {
      const userId = Number(req.query.userId || 0);
      if (!userId) {
        res.status(400).json({ error: "Falta userId" });
        return;
      }
      const purchased = await q(
        `SELECT up.id AS users_package_id, pp.id, pp.name, pp.subtitle, pp.description,
                pp.price, pp.currency, pp.paid, pp.id_status, st.name AS status_name,
                pp.id_package, p.name AS package_name
           FROM users_packages up
           JOIN purchased_packages pp ON pp.id = up.id_purchased_package AND pp.active = 1
           LEFT JOIN status st ON st.id = pp.id_status
           LEFT JOIN packages p ON p.id = pp.id_package
          WHERE up.id_user = ? AND up.active = 1
          ORDER BY up.id DESC`,
        [userId]
      );
      const catalog = await q(
        `SELECT id, name, subtitle, price, currency FROM packages
          WHERE active = 1 AND (is_extern = 0 OR is_extern IS NULL)
          ORDER BY id ASC`
      );
      res.status(200).json({
        purchasedPackages: purchased.map((r: any) => ({
          usersPackageId: r.users_package_id,
          id: r.id,
          name: r.name,
          subtitle: r.subtitle,
          description: r.description,
          price: Number(r.price || 0),
          paid: Number(r.paid || 0),
          currency: r.currency || "MXN",
          status: r.status_name || "Pendiente",
          packageId: r.id_package,
          packageName: r.package_name,
        })),
        catalog: catalog.map((r: any) => ({
          id: r.id,
          name: r.name,
          subtitle: r.subtitle,
          price: Number(r.price || 0),
          currency: r.currency || "MXN",
        })),
      });
      return;
    }

    if (req.method === "POST") {
      const b = (req.body || {}) as Record<string, unknown>;
      const userId = Number(b.userId || 0);
      if (!userId) {
        res.status(400).json({ error: "Falta userId" });
        return;
      }
      const user = await q(`SELECT id FROM users WHERE id = ? AND active = 1`, [userId]);
      if (!user.length) {
        res.status(404).json({ error: "Usuario no encontrado" });
        return;
      }

      // Quitar: baja logica del vinculo users_packages
      if (b.usersPackageId !== undefined && b.usersPackageId !== null && b.usersPackageId !== "") {
        const linkId = Number(b.usersPackageId || 0);
        if (!linkId) {
          res.status(400).json({ error: "usersPackageId invalido" });
          return;
        }
        const r = await exec(
          `UPDATE users_packages SET active = 0 WHERE id = ? AND id_user = ?`,
          [linkId, userId]
        );
        if (!r.affectedRows) {
          res.status(404).json({ error: "Paquete no encontrado para este cliente" });
          return;
        }
        res.status(200).json({ ok: true, removed: true });
        return;
      }

      // Asignar una compra existente (purchased_packages) al cliente
      if (b.purchasedPackageId !== undefined && b.purchasedPackageId !== null && b.purchasedPackageId !== "") {
        const ppId = Number(b.purchasedPackageId || 0);
        if (!ppId) {
          res.status(400).json({ error: "purchasedPackageId invalido" });
          return;
        }
        const exists = await q(
          `SELECT id FROM purchased_packages WHERE id = ? AND active = 1`,
          [ppId]
        );
        if (!exists.length) {
          res.status(404).json({ error: "Paquete comprado no encontrado" });
          return;
        }
        const dup = await q(
          `SELECT id FROM users_packages WHERE id_user = ? AND id_purchased_package = ? AND active = 1`,
          [userId, ppId]
        );
        if (dup.length) {
          res.status(409).json({ error: "Ese paquete ya esta asignado al cliente" });
          return;
        }
        const r = await exec(
          `INSERT INTO users_packages (id_user, id_purchased_package) VALUES (?, ?)`,
          [userId, ppId]
        );
        res.status(201).json({ ok: true, id: r.insertId });
        return;
      }

      // Crear compra nueva desde el catalogo y asignarla
      const packageId = Number(b.packageId || 0);
      if (!packageId) {
        res.status(400).json({ error: "Indica packageId, purchasedPackageId o usersPackageId" });
        return;
      }
      const pkg: any[] = await q(
        `SELECT id, name, subtitle, description, price, currency, id_tier, id_package_category
           FROM packages WHERE id = ? AND active = 1`,
        [packageId]
      );
      if (!pkg.length) {
        res.status(404).json({ error: "Paquete no encontrado" });
        return;
      }
      const p = pkg[0];
      const price = b.price !== undefined && b.price !== null && b.price !== "" ? Number(b.price) : Number(p.price || 0);
      const paid = b.paid !== undefined && b.paid !== null && b.paid !== "" ? Number(b.paid) : 0;

      const result = await transaccion(async (conn) => {
        const [ppRes]: any[] = await conn.query(
          `INSERT INTO purchased_packages
             (name, subtitle, description, price, currency, paid, id_status, id_package, id_package_category, id_tier)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          [p.name, p.subtitle, p.description, price, p.currency || "MXN", paid, p.id, p.id_package_category, p.id_tier]
        );
        const ppId = Number(ppRes.insertId);
        // Copia los servicios del paquete a la compra (como el seed)
        const [svcRows]: any[] = await conn.query(
          `SELECT id_service FROM packages_services WHERE id_package = ? AND active = 1`,
          [p.id]
        );
        for (const s of svcRows) {
          await conn.query(
            `INSERT INTO purchased_packages_services (id_purchased_package, id_status, id_service)
             VALUES (?, 1, ?)`,
            [ppId, s.id_service]
          );
        }
        const [linkRes]: any[] = await conn.query(
          `INSERT INTO users_packages (id_user, id_purchased_package) VALUES (?, ?)`,
          [userId, ppId]
        );
        return { purchasedPackageId: ppId, usersPackageId: Number((linkRes as any).insertId) };
      });

      res.status(201).json({ ok: true, ...result });
      return;
    }

    res.status(405).json({ error: "Metodo no permitido" });
  } catch (e) {
    console.error("[admin/client-packages]", e);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});
