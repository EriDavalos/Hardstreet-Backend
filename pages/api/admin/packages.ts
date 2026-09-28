import type { NextApiRequest, NextApiResponse } from "next";
import bcrypt from "bcryptjs";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { q, exec, transaccion } from "../../../lib/db";

// ==================================================================
// Catálogo de PAQUETES (solo con permiso sobre el módulo "paquetes")
//   ->  /api/admin/packages
//   GET            lista TODO el catálogo (con tier, categoría y servicios)
//   POST           crea paquete { name, subtitle?, description?, price,
//                  currency?, id_tier, id_package_category, is_extern?,
//                  url_image?, serviceIds?: number[] }
//   PUT/PATCH      actualiza { id, ...campos?, serviceIds?: number[] }
//   DELETE         baja lógica (?id=N) — active = 0
//
// Los "servicios incluidos" se administran con packages_services:
// serviceIds reemplaza el set completo (baja lógica de los quitados).
// ==================================================================

const norm = (v: unknown) => (typeof v === "string" ? v.trim() : "");

async function resolveServiceIds(
  res: NextApiResponse,
  raw: unknown
): Promise<number[] | null | undefined> {
  if (raw === undefined) return undefined; // no vino el campo
  if (!Array.isArray(raw)) {
    res.status(400).json({ error: "serviceIds debe ser una lista de ids" });
    return null;
  }
  const ids = [...new Set(raw.map((v) => Number(v) || 0).filter(Boolean))];
  if (ids.length) {
    const found = await q<{ id: number }>(
      `SELECT id FROM services WHERE active = 1 AND id IN (?)`,
      [ids]
    );
    const valid = new Set(found.map((f) => Number(f.id)));
    const missing = ids.filter((id) => !valid.has(id));
    if (missing.length) {
      res.status(400).json({ error: `Servicio inexistente: id ${missing[0]}` });
      return null;
    }
  }
  return ids;
}

async function replaceServices(
  conn: import("mysql2/promise").PoolConnection,
  packageId: number,
  serviceIds: number[]
) {
  await conn.query(
    `UPDATE packages_services SET active = 0 WHERE id_package = ?`,
    [packageId]
  );
  for (const sid of serviceIds) {
    const [rows]: any[] = await conn.query(
      `SELECT id FROM packages_services
        WHERE id_package = ? AND id_service = ? LIMIT 1`,
      [packageId, sid]
    );
    if ((rows as any[]).length) {
      await conn.query(`UPDATE packages_services SET active = 1 WHERE id = ?`, [
        (rows as any[])[0].id,
      ]);
    } else {
      await conn.query(
        `INSERT INTO packages_services (id_package, id_service) VALUES (?, ?)`,
        [packageId, sid]
      );
    }
  }
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  // Permiso por acción sobre el módulo "paquetes" (Admin pasa siempre).
  const ACTIONS: Record<string, "read" | "create" | "update" | "delete"> = {
    GET: "read",
    POST: "create",
    PUT: "update",
    PATCH: "update",
    DELETE: "delete",
  };
  const action = ACTIONS[req.method || ""];
  if (!action) {
    res.status(405).json({ error: "Metodo no permitido" });
    return;
  }
  if (!(await requirePermission(req, res, "paquetes", action))) return;

  try {
    switch (req.method) {
      case "GET": {
        const rows = await q<{
          id: number;
          name: string | null;
          subtitle: string | null;
          description: string | null;
          price: string | number | null;
          currency: string | null;
          id_tier: number | null;
          id_package_category: number | null;
          is_extern: number | null;
          url_image: string | null;
          tier_name: string | null;
          tier_num: number | null;
          cat_name: string | null;
        }>(
          `SELECT p.id, p.name, p.subtitle, p.description, p.price, p.currency,
                  p.id_tier, p.id_package_category, p.is_extern, p.url_image,
                  t.name AS tier_name, t.tier AS tier_num,
                  pc.name AS cat_name
             FROM packages p
             LEFT JOIN tiers t ON t.id = p.id_tier
             LEFT JOIN packages_categories pc ON pc.id = p.id_package_category
            WHERE p.active = 1
            ORDER BY p.id ASC`
        );
        const svcRows = await q<{ id_package: number; id: number; name: string | null }>(
          `SELECT ps.id_package, s.id, s.name
             FROM packages_services ps
             JOIN services s ON s.id = ps.id_service AND s.active = 1
            WHERE ps.active = 1
            ORDER BY ps.id ASC`
        );
        res.status(200).json({
          packages: rows.map((p) => ({
            id: p.id,
            name: p.name || "",
            subtitle: p.subtitle || "",
            description: p.description || "",
            price: Number(p.price || 0),
            currency: p.currency || "MXN",
            tierId: p.id_tier,
            tierName: p.tier_name || "",
            tierNum: Number(p.tier_num || 3),
            categoryId: p.id_package_category,
            categoryName: p.cat_name || "",
            isExtern: p.is_extern === 1,
            urlImage: p.url_image || "",
            serviceIds: svcRows.filter((s) => s.id_package === p.id).map((s) => Number(s.id)),
            serviceNames: svcRows
              .filter((s) => s.id_package === p.id)
              .map((s) => s.name || ""),
          })),
        });
        return;
      }

      case "POST": {
        const b = (req.body || {}) as Record<string, unknown>;
        const name = norm(b.name);
        if (!name) {
          res.status(400).json({ error: "El nombre del paquete es obligatorio" });
          return;
        }
        const tierId = Number(b.id_tier || 0) || null;
        const catId = Number(b.id_package_category || 0) || null;
        if (!tierId) {
          res.status(400).json({ error: "Indica el tier del paquete" });
          return;
        }
        if (!catId) {
          res.status(400).json({ error: "Indica la categoría del paquete" });
          return;
        }
        const tier = await q(`SELECT id FROM tiers WHERE id = ? AND active = 1`, [tierId]);
        if (!tier.length) {
          res.status(400).json({ error: "El tier indicado no existe" });
          return;
        }
        const cat = await q(`SELECT id FROM packages_categories WHERE id = ? AND active = 1`, [catId]);
        if (!cat.length) {
          res.status(400).json({ error: "La categoría indicada no existe" });
          return;
        }
        const serviceIds = await resolveServiceIds(res, b.serviceIds);
        if (serviceIds === null) return;

        const price = Number(b.price || 0);
        const r = await exec(
          `INSERT INTO packages (name, subtitle, description, price, currency, id_tier, id_package_category, is_extern, url_image)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            name,
            norm(b.subtitle),
            norm(b.description),
            price,
            norm(b.currency) || "MXN",
            tierId,
            catId,
            b.is_extern === true || b.is_extern === 1 ? 1 : 0,
            norm(b.url_image) || null,
          ]
        );
        if (serviceIds && serviceIds.length) {
          await transaccion((conn) => replaceServices(conn, r.insertId, serviceIds));
        }
        res.status(201).json({ ok: true, id: r.insertId });
        return;
      }

      case "PUT":
      case "PATCH": {
        const b = (req.body || {}) as Record<string, unknown>;
        const id = Number(b.id || 0);
        if (!id) {
          res.status(400).json({ error: "Falta el id del paquete" });
          return;
        }
        const exists = await q(`SELECT id FROM packages WHERE id = ? AND active = 1`, [id]);
        if (!exists.length) {
          res.status(404).json({ error: "Paquete no encontrado" });
          return;
        }
        const fields: string[] = [];
        const params: unknown[] = [];
        for (const key of ["name", "subtitle", "description"] as const) {
          if (b[key] !== undefined) {
            const v = norm(b[key]);
            if (key === "name" && !v) {
              res.status(400).json({ error: "El nombre no puede estar vacío" });
              return;
            }
            fields.push(`\`${key}\` = ?`);
            params.push(v);
          }
        }
        if (b.price !== undefined) {
          fields.push("`price` = ?");
          params.push(Number(b.price || 0));
        }
        if (b.currency !== undefined) {
          fields.push("`currency` = ?");
          params.push(norm(b.currency) || "MXN");
        }
        if (b.url_image !== undefined) {
          fields.push("`url_image` = ?");
          params.push(norm(b.url_image) || null);
        }
        if (b.is_extern !== undefined) {
          fields.push("`is_extern` = ?");
          params.push(b.is_extern === true || b.is_extern === 1 ? 1 : 0);
        }
        if (b.id_tier !== undefined) {
          const tierId = Number(b.id_tier || 0) || null;
          if (tierId) {
            const tier = await q(`SELECT id FROM tiers WHERE id = ? AND active = 1`, [tierId]);
            if (!tier.length) {
              res.status(400).json({ error: "El tier indicado no existe" });
              return;
            }
          }
          fields.push("`id_tier` = ?");
          params.push(tierId);
        }
        if (b.id_package_category !== undefined) {
          const catId = Number(b.id_package_category || 0) || null;
          if (catId) {
            const cat = await q(
              `SELECT id FROM packages_categories WHERE id = ? AND active = 1`,
              [catId]
            );
            if (!cat.length) {
              res.status(400).json({ error: "La categoría indicada no existe" });
              return;
            }
          }
          fields.push("`id_package_category` = ?");
          params.push(catId);
        }
        if (fields.length) {
          await exec(`UPDATE packages SET ${fields.join(", ")} WHERE id = ?`, [...params, id]);
        }
        // Servicios incluidos (reemplaza el set completo si vino el campo).
        const serviceIds = await resolveServiceIds(res, b.serviceIds);
        if (serviceIds === null) return;
        if (serviceIds !== undefined) {
          await transaccion((conn) => replaceServices(conn, id, serviceIds));
        }
        res.status(200).json({ ok: true });
        return;
      }

      case "DELETE": {
        const id = Number(req.query.id || 0);
        if (!id) {
          res.status(400).json({ error: "Falta el id del paquete" });
          return;
        }
        // ¿El paquete está vendido a algún cliente? No se puede eliminar.
        const sold = await q(
          `SELECT id FROM users_packages WHERE id_purchased_package IN
             (SELECT id FROM purchased_packages WHERE id_package = ? AND active = 1)
            AND active = 1 LIMIT 1`,
          [id]
        );
        if (sold.length) {
          res.status(409).json({
            error: "No se puede eliminar: hay clientes con este paquete asignado",
          });
          return;
        }
        const r = await exec(`UPDATE packages SET active = 0 WHERE id = ?`, [id]);
        if (!r.affectedRows) {
          res.status(404).json({ error: "Paquete no encontrado" });
          return;
        }
        res.status(200).json({ ok: true });
        return;
      }

      default:
        res.status(405).json({ error: "Metodo no permitido" });
    }
  } catch (e) {
    console.error("[admin/packages]", e);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});
