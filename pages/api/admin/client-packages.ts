import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { q, exec, transaccion } from "../../../lib/db";
import { ok, created, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";
import { packageDrivePathsByIds } from "../../../lib/drive-paths";

// ==================================================================
// Paquetes de un cliente (solo rol Admin)  ->  /api/admin/client-packages
//   GET  ?userId=N        purchased_packages del cliente + catalogo para asignar
//   POST { userId, purchasedPackageId }   -> asigna (users_packages)
//   POST { userId, usersPackageId }       -> quita (baja logica del vinculo)
//   POST { userId, packageId, price?, paid? } -> crea compra nueva desde catalogo
// ==================================================================

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  // Permiso sobre "clientes": ver para GET; editar para asignar/quitar.
  let me: { sub: number; role: string } | null = null;
  if (req.method === "GET") {
    me = await requirePermission(req, res, "clientes", "read");
  } else if (req.method === "POST") {
    me = await requirePermission(req, res, "clientes", "update");
  } else {
    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
    return;
  }
  if (!me) return;

  try {
    if (req.method === "GET") {
      const userId = Number(req.query.userId || 0);
      if (!userId) {
        fail(res, 400, "Falta userId", "Indica de qué cliente quieres los paquetes");
        return;
      }
      const purchased = await q(
        `SELECT up.id AS users_package_id, pp.id, pp.name, pp.subtitle, pp.description,
                pp.price, pp.currency, pp.paid, pp.id_status, st.name AS status_name,
                pp.id_package, p.name AS package_name,
                t.name AS tier_name, pc.name AS category_name, p.url_image,
                (SELECT COUNT(*) FROM schedules ag
                  WHERE ag.id_purchased_package = pp.id AND ag.active = 1) AS agendas_count
           FROM users_packages up
           JOIN purchased_packages pp ON pp.id = up.id_purchased_package AND pp.active = 1
           LEFT JOIN status st ON st.id = pp.id_status
           LEFT JOIN packages p ON p.id = pp.id_package
           LEFT JOIN tiers t ON t.id = pp.id_tier
           LEFT JOIN packages_categories pc ON pc.id = pp.id_package_category
          WHERE up.id_user = ? AND up.active = 1
          ORDER BY up.id DESC`,
        [userId]
      );
      // Servicios de cada compra (el panel los usa para el combo de agendas).
      const purchasedIds = purchased
        .map((r: any) => Number(r.id))
        .filter((v: number) => !!v);
      let pkgServices: any[] = [];
      if (purchasedIds.length) {
        try {
          pkgServices = await q(
            `SELECT pps.id, pps.id_purchased_package, pps.id_service, pps.description,
                    s.name AS service_name, s.url AS service_url, st.name AS status_name
               FROM purchased_packages_services pps
               LEFT JOIN services s ON s.id = pps.id_service
               LEFT JOIN status st ON st.id = pps.id_status
              WHERE pps.active = 1 AND pps.id_purchased_package IN (?)
              ORDER BY pps.id ASC`,
            [purchasedIds]
          );
        } catch {
          // Migración 2026-10-13_services_url.sql aún no aplicada: sin ligas.
          pkgServices = await q(
            `SELECT pps.id, pps.id_purchased_package, pps.id_service, pps.description,
                    s.name AS service_name, st.name AS status_name
               FROM purchased_packages_services pps
               LEFT JOIN services s ON s.id = pps.id_service
               LEFT JOIN status st ON st.id = pps.id_status
              WHERE pps.active = 1 AND pps.id_purchased_package IN (?)
              ORDER BY pps.id ASC`,
            [purchasedIds]
          );
        }
      }
      // Carpetas del Drive compartidas por cada compra (puede haber VARIAS
      // por paquete): el panel las necesita para NO ofrecer una carpeta que se
      // solape con otra ya compartida a este mismo cliente. Sin migración →
      // sin datos, sin romper el listado.
      const drivePaths = purchasedIds.length
        ? await packageDrivePathsByIds(purchasedIds.map((i) => Number(i)))
        : new Map<number, string[]>();
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
          // Identidad del catálogo: el panel pinta el paquete con el mismo
          // "flyer" que la web (tier, categoría e imagen).
          tierName: r.tier_name || "",
          categoryName: r.category_name || "",
          urlImage: r.url_image || "",
          agendaCount: Number(r.agendas_count || 0),
          // Carpetas compartidas del Drive ([] = ninguna). `drivePath` es la
          // primera (compatibilidad).
          drivePath: (drivePaths.get(Number(r.id)) ?? [])[0] || "",
          drivePaths: drivePaths.get(Number(r.id)) ?? [],
          services: pkgServices
            .filter((s: any) => Number(s.id_purchased_package) === Number(r.id))
            .map((s: any) => ({
              id: Number(s.id),
              serviceId: Number(s.id_service || 0),
              name: s.service_name || "",
              description: s.description || "",
              url: s.service_url || "",
              status: s.status_name || "Pendiente",
            })),
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
        fail(res, 400, "Falta userId", "Indica a qué cliente le vas a mover los paquetes");
        return;
      }
      const user = await q(`SELECT id FROM users WHERE id = ? AND active = 1`, [userId]);
      if (!user.length) {
        fail(res, 404, "Usuario no encontrado", `No hay un usuario activo con id ${userId}`);
        return;
      }

      // Quitar: baja logica del vinculo users_packages
      if (b.usersPackageId !== undefined && b.usersPackageId !== null && b.usersPackageId !== "") {
        const linkId = Number(b.usersPackageId || 0);
        if (!linkId) {
          fail(res, 400, "usersPackageId inválido", "Indica qué paquete del cliente quieres quitar");
          return;
        }
        const r = await exec(
          `UPDATE users_packages SET active = 0 WHERE id = ? AND id_user = ?`,
          [linkId, userId]
        );
        if (!r.affectedRows) {
          fail(res, 404, "Paquete no encontrado para este cliente", `El vínculo ${linkId} no existe o ya estaba inactivo`);
          return;
        }
        await logActivity({
          userId: me.sub,
          module: "clientes",
          moduleName: "Clientes",
          action: "delete",
          entity: "paquete-cliente",
          entityId: linkId,
          description: "Paquete quitado del cliente exitosamente",
          details: { userId, usersPackageId: linkId },
          req,
        });
        ok(res, "Paquete quitado del cliente exitosamente", {
          removed: true,
          item: { usersPackageId: linkId, userId },
        });
        return;
      }

      // Asignar una compra existente (purchased_packages) al cliente
      if (b.purchasedPackageId !== undefined && b.purchasedPackageId !== null && b.purchasedPackageId !== "") {
        const ppId = Number(b.purchasedPackageId || 0);
        if (!ppId) {
          fail(res, 400, "purchasedPackageId inválido", "Indica qué paquete quieres asignar");
          return;
        }
        const exists = await q(
          `SELECT id FROM purchased_packages WHERE id = ? AND active = 1`,
          [ppId]
        );
        if (!exists.length) {
          fail(res, 404, "Paquete comprado no encontrado", `No hay un paquete con id ${ppId}`);
          return;
        }
        const dup = await q(
          `SELECT id FROM users_packages WHERE id_user = ? AND id_purchased_package = ? AND active = 1`,
          [userId, ppId]
        );
        if (dup.length) {
          fail(res, 409, "Ese paquete ya está asignado al cliente", `users_packages existente #${dup.length}`);
          return;
        }
        const r = await exec(
          `INSERT INTO users_packages (id_user, id_purchased_package) VALUES (?, ?)`,
          [userId, ppId]
        );
        await logActivity({
          userId: me.sub,
          module: "clientes",
          moduleName: "Clientes",
          action: "create",
          entity: "paquete-cliente",
          entityId: r.insertId,
          description: "Paquete asignado al cliente exitosamente",
          details: { userId, purchasedPackageId: ppId },
          req,
        });
        created(res, "Paquete asignado al cliente exitosamente", {
          item: { usersPackageId: r.insertId, userId, purchasedPackageId: ppId },
        });
        return;
      }

      // Crear compra nueva desde el catalogo y asignarla
      const packageId = Number(b.packageId || 0);
      if (!packageId) {
        fail(
          res,
          400,
          "Indica packageId, purchasedPackageId o usersPackageId",
          "Elige un paquete del catálogo o una compra existente"
        );
        return;
      }
      const pkg: any[] = await q(
        `SELECT id, name, subtitle, description, price, currency, id_tier, id_package_category
           FROM packages WHERE id = ? AND active = 1`,
        [packageId]
      );
      if (!pkg.length) {
        fail(res, 404, "Paquete no encontrado", `No hay un paquete activo con id ${packageId}`);
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
        // Copia los servicios del paquete a la compra (como el seed).
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

      const item = { userId, ...result, packageId };
      await logActivity({
        userId: me.sub,
        module: "clientes",
        moduleName: "Clientes",
        action: "create",
        entity: "compra-paquete",
        entityId: result.purchasedPackageId,
        description: "Paquete creado y asignado al cliente exitosamente",
        details: item,
        req,
      });
      created(res, "Paquete creado y asignado al cliente exitosamente", {
        ...result,
        item,
      });
      return;
    }

    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
  } catch (e) {
    console.error("[admin/client-packages]", e);
    fail(res, 500, "Hubo un error", "No se pudo completar la operación de los paquetes del cliente");
  }
});
