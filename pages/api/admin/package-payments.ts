import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { q, transaccion } from "../../../lib/db";
import { ok, created, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";

// ==================================================================
// Abonos de un paquete comprado  ->  /api/admin/package-payments
//   GET    ?userId=N | ?purchasedPackageId=N   lista de abonos
//   POST   { purchasedPackageId, amount, description }
//   DELETE ?id=N                               baja logica + recalcula paid
//
// Cada abono vive en purchased_packages_payments y el total pagado del
// paquete (purchased_packages.paid) se RECALCULA como la suma de sus
// abonos activos, para que el panel y la web siempre vean lo mismo.
// Permiso: modulo "clientes" (ver para GET; editar para abonar/quitar).
// ==================================================================

/** Recalcula purchased_packages.paid sumando los abonos activos. */
async function recomputePaid(
  conn: import("mysql2/promise").PoolConnection,
  purchasedPackageId: number
): Promise<number> {
  const [rows]: any[] = await conn.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
       FROM purchased_packages_payments
      WHERE id_purchased_package = ? AND active = 1`,
    [purchasedPackageId]
  );
  const paid = Number((rows as any[])[0]?.total || 0);
  await conn.query(`UPDATE purchased_packages SET paid = ? WHERE id = ?`, [
    paid,
    purchasedPackageId,
  ]);
  return paid;
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  const ACTIONS: Record<string, "read" | "update"> = {
    GET: "read",
    POST: "update",
    DELETE: "update",
  };
  const action = ACTIONS[req.method || ""];
  if (!action) {
    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
    return;
  }
  const me = await requirePermission(req, res, "clientes", action);
  if (!me) return;

  try {
    // ---------------- Listar abonos ----------------
    if (req.method === "GET") {
      const userId = Number(req.query.userId || 0);
      const purchasedPackageId = Number(req.query.purchasedPackageId || 0);
      if (!userId && !purchasedPackageId) {
        fail(res, 400, "Falta userId o purchasedPackageId", "Indica de qué cliente o paquete quieres los abonos");
        return;
      }

      const where: string[] = ["p.active = 1"];
      const params: unknown[] = [];
      if (purchasedPackageId) {
        params.push(purchasedPackageId);
        where.push("p.id_purchased_package = ?");
      }
      if (userId) params.push(userId);

      const rows = await q(
        `SELECT p.id, p.id_purchased_package, p.amount, p.description,
                DATE_FORMAT(p.created, '%Y-%m-%dT%H:%i:%s') AS created
           FROM purchased_packages_payments p
           ${
             userId
               ? "JOIN users_packages up ON up.id_purchased_package = p.id_purchased_package AND up.active = 1"
               : ""
           }
          WHERE ${where.join(" AND ")}${userId ? " AND up.id_user = ?" : ""}
          ORDER BY p.created DESC, p.id DESC`,
        params
      );

      res.status(200).json({
        payments: rows.map((r: any) => ({
          id: Number(r.id),
          purchasedPackageId: Number(r.id_purchased_package || 0),
          amount: Number(r.amount || 0),
          description: r.description ? String(r.description) : "",
          created: r.created || "",
        })),
      });
      return;
    }

    // ---------------- Abonar ----------------
    if (req.method === "POST") {
      const b = (req.body || {}) as Record<string, unknown>;
      const purchasedPackageId = Number(b.purchasedPackageId || 0);
      if (!purchasedPackageId) {
        fail(res, 400, "Indica el paquete comprado", "El abono debe pertenecer a un paquete del cliente");
        return;
      }
      const amount = Number(b.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        fail(res, 400, "El monto del abono debe ser mayor a 0", "Escribe un monto válido");
        return;
      }
      const exists = await q(
        `SELECT id FROM purchased_packages WHERE id = ? AND active = 1`,
        [purchasedPackageId]
      );
      if (!exists.length) {
        fail(res, 404, "Paquete comprado no encontrado", `No hay un paquete con id ${purchasedPackageId}`);
        return;
      }
      const description =
        typeof b.description === "string" ? b.description.trim() : "";

      const out = await transaccion(async (conn) => {
        const [ins]: any[] = await conn.query(
          `INSERT INTO purchased_packages_payments (id_purchased_package, amount, description)
           VALUES (?, ?, ?)`,
          [purchasedPackageId, amount, description || null]
        );
        const paid = await recomputePaid(conn, purchasedPackageId);
        return { id: Number(ins.insertId), paid };
      });

      const item = { id: out.id, purchasedPackageId, amount, description };
      await logActivity({
        userId: me.sub,
        module: "clientes",
        moduleName: "Clientes",
        action: "create",
        entity: "abono",
        entityId: out.id,
        description: "Abono registrado exitosamente",
        details: item,
        req,
      });
      created(res, "Abono registrado exitosamente", { ...out, item });
      return;
    }

    // ---------------- Quitar abono ----------------
    if (req.method === "DELETE") {
      const id = Number(req.query.id || 0);
      if (!id) {
        fail(res, 400, "Falta el id del abono", "Indica qué abono quieres eliminar");
        return;
      }
      const found = await q<{ id_purchased_package: number | null }>(
        `SELECT id_purchased_package FROM purchased_packages_payments
          WHERE id = ? AND active = 1`,
        [id]
      );
      if (!found.length) {
        fail(res, 404, "Abono no encontrado", `No hay un abono activo con id ${id}`);
        return;
      }
      const purchasedPackageId = Number(found[0].id_purchased_package || 0);

      const paid = await transaccion(async (conn) => {
        await conn.query(
          `UPDATE purchased_packages_payments SET active = 0 WHERE id = ?`,
          [id]
        );
        return purchasedPackageId ? await recomputePaid(conn, purchasedPackageId) : 0;
      });

      await logActivity({
        userId: me.sub,
        module: "clientes",
        moduleName: "Clientes",
        action: "delete",
        entity: "abono",
        entityId: id,
        description: "Abono eliminado exitosamente",
        details: { id, paid },
        req,
      });
      ok(res, "Abono eliminado exitosamente", { paid, item: { id, paid } });
      return;
    }

    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
  } catch (e) {
    console.error("[admin/package-payments]", e);
    fail(res, 500, "Hubo un error", "No se pudo completar la operación del abono");
  }
});
