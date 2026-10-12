import type { NextApiRequest, NextApiResponse } from "next";
import type { PoolConnection } from "mysql2/promise";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { q, exec, transaccion } from "../../../lib/db";

// ==================================================================
// ADMINISTRACIÓN DEL PAQUETE DEL CLIENTE -> /api/admin/package-progress
//
//   GET  ?purchasedPackageId=N
//        { package, services, movements, totals, canFinish, blockers }
//
//   POST  { action, ... }
//     abonar              { purchasedPackageId, amount, description }
//     movimiento          { purchasedPackageId, kind, amount, description }
//     quitar-movimiento   { movementId, source }
//     completar-servicio  { serviceId, description? }
//     reabrir-servicio    { serviceId }
//     actualizar-servicio { serviceId, description }
//     finalizar           { purchasedPackageId }
//     reabrir-paquete     { purchasedPackageId }
//
// Requiere la migración 2026-10-12_package_admin.sql:
//   * purchased_packages_movements (inversion | gasto | abono_externo)
//   * purchased_packages_services.finished_at
//   * purchased_packages.finished_at
//   * status 6 = 'Terminado'
//
// Los ABONOS siguen guardándose en purchased_packages_payments: es la tabla
// que alimenta `purchased_packages.paid` (y la que ya usa la web).
// Permiso: módulo "clientes" (ver para GET, editar para el resto).
// ==================================================================

/** Estados de la tabla `status`. */
const ST_DONE = 3; // Entregado  -> servicio terminado
const ST_PROCESS = 2; // En proceso -> servicio reabierto
const ST_FINISHED = 6; // Terminado  -> paquete cerrado

/** Tipos de movimiento propios (los abonos van aparte). */
const MOVEMENT_KINDS = ["inversion", "gasto", "abono_externo"] as const;
type MovementKind = (typeof MOVEMENT_KINDS)[number];

const norm = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function asAmount(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function asKind(raw: unknown): MovementKind | null {
  const k = norm(raw).toLowerCase().replace(/-/g, "_");
  return (MOVEMENT_KINDS as readonly string[]).includes(k)
    ? (k as MovementKind)
    : null;
}

/** Recalcula purchased_packages.paid sumando los abonos activos. */
async function recomputePaid(
  conn: PoolConnection,
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

type Row = Record<string, any>;

/** Totales por tipo de movimiento + abonado. */
function sumBy(rows: Row[], predicate: (r: Row) => boolean): number {
  return rows
    .filter(predicate)
    .reduce((a, r) => a + Number(r.amount || 0), 0);
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  const action = req.method === "GET" ? "read" : "update";
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Metodo no permitido" });
    return;
  }
  if (!(await requirePermission(req, res, "clientes", action))) return;

  try {
    // ================================ GET ================================
    if (req.method === "GET") {
      const purchasedPackageId = Number(req.query.purchasedPackageId || 0);
      if (!purchasedPackageId) {
        res.status(400).json({ error: "Falta purchasedPackageId" });
        return;
      }
      const pkgRows = await q<Row>(
        `SELECT pp.id, pp.name, pp.price, pp.paid, pp.id_status,
                st.name AS status_name,
                DATE_FORMAT(pp.finished_at, '%Y-%m-%dT%H:%i:%s') AS finished_at
           FROM purchased_packages pp
           LEFT JOIN status st ON st.id = pp.id_status
          WHERE pp.id = ? AND pp.active = 1`,
        [purchasedPackageId]
      );
      if (!pkgRows.length) {
        res.status(404).json({ error: "Paquete comprado no encontrado" });
        return;
      }

      const services = await q<Row>(
        `SELECT pps.id, pps.id_service, pps.description, pps.id_status,
                st.name AS status_name,
                DATE_FORMAT(pps.finished_at, '%Y-%m-%dT%H:%i:%s') AS finished_at,
                s.name AS service_name, s.icon AS service_icon
           FROM purchased_packages_services pps
           LEFT JOIN services s ON s.id = pps.id_service
           LEFT JOIN status st ON st.id = pps.id_status
          WHERE pps.id_purchased_package = ? AND pps.active = 1
          ORDER BY pps.id ASC`,
        [purchasedPackageId]
      );

      // Movimientos = abonos (payments) + movimientos propios. Si la
      // migración aún no se aplicó, el modal sigue funcionando sin ellos.
      let movements: Row[] = [];
      let movementsAvailable = true;
      try {
        // El `kind` sale del UNION: los abonos son 'abono' y los
        // movimientos propios conservan su tipo (antes TODOS salían como
        // 'abono', así que un gasto nunca se contaba como gasto y todo se
        // colaba en el total abonado).
        movements = await q<Row>(
          `SELECT id, kind, amount, description, source, created
             FROM (
               SELECT id, 'abono' AS kind, amount, description,
                      'payment' AS source,
                      DATE_FORMAT(created, '%Y-%m-%dT%H:%i:%s') AS created
                 FROM purchased_packages_payments
                WHERE id_purchased_package = ? AND active = 1
               UNION ALL
               SELECT id, kind, amount, description, 'movement' AS source,
                      DATE_FORMAT(created, '%Y-%m-%dT%H:%i:%s') AS created
                 FROM purchased_packages_movements
                WHERE id_purchased_package = ? AND active = 1
             ) m
            ORDER BY m.created DESC, m.id DESC`,
          [purchasedPackageId, purchasedPackageId]
        );
      } catch (e) {
        movementsAvailable = false;
        console.error("[admin/package-progress] movimientos:", e);
      }

      const pkg = pkgRows[0];
      const price = Number(pkg.price || 0);
      const paid = Number(pkg.paid || 0);
      const pending = services.filter((s) => Number(s.id_status) !== ST_DONE);
      const finished = Number(pkg.id_status) === ST_FINISHED;
      const missing = Math.max(0, Math.round((price - paid) * 100) / 100);

      const blockers: string[] = [];
      if (pending.length) {
        blockers.push(
          pending.length === 1
            ? "Falta terminar 1 servicio del paquete"
            : `Faltan terminar ${pending.length} servicios del paquete`
        );
      }
      if (missing > 0) {
        blockers.push(
          `El pago está incompleto: falta por abonar ${missing.toFixed(2)}`
        );
      }

      res.status(200).json({
        package: {
          id: Number(pkg.id),
          name: String(pkg.name || ""),
          price,
          paid,
          balance: Math.max(0, Math.round((price - paid) * 100) / 100),
          status: String(pkg.status_name || "Pendiente"),
          statusId: Number(pkg.id_status || 0),
          finished,
          finishedAt: pkg.finished_at || null,
        },
        services: services.map((s) => ({
          id: Number(s.id),
          serviceId: Number(s.id_service || 0),
          name: String(s.service_name || "Servicio"),
          icon: String(s.service_icon || ""),
          description: String(s.description || ""),
          status: String(s.status_name || "Pendiente"),
          statusId: Number(s.id_status || 0),
          done: Number(s.id_status) === ST_DONE,
          finishedAt: s.finished_at || null,
        })),
        movements: movements.map((m) => ({
          id: Number(m.id),
          kind: String(m.kind || "gasto"),
          source: String(m.source || "movement"),
          amount: Number(m.amount || 0),
          description: String(m.description || ""),
          created: m.created || "",
        })),
        movementsAvailable,
        // Estos totales son SOLO informativos de la pestaña Movimientos:
        // gastos, inversiones y abonos externos NO tocan `paid` (abonado)
        // ni el saldo, que siguen saliendo de purchased_packages_payments.
        totals: (() => {
          const invertido = sumBy(movements, (m) => m.kind === "inversion");
          return {
            abonado: sumBy(movements, (m) => m.kind === "abono"),
            invertido,
            // Inversión = un tipo de gasto: "Gastado" incluye ambos.
            gastado: sumBy(movements, (m) => m.kind === "gasto") + invertido,
            abonoExterno: sumBy(movements, (m) => m.kind === "abono_externo"),
          };
        })(),
        canFinish: !finished && pending.length === 0 && missing <= 0,
        blockers,
      });
      return;
    }

    // ================================ POST ================================
    const b = (req.body || {}) as Record<string, unknown>;
    const actionName = norm(b.action).toLowerCase();

    // ---- Finalizar el paquete (con validaciones) ----
    if (actionName === "finalizar") {
      const purchasedPackageId = Number(b.purchasedPackageId || 0);
      if (!purchasedPackageId) {
        res.status(400).json({ error: "Indica el paquete comprado" });
        return;
      }
      const rows = await q<Row>(
        `SELECT id, price, paid, id_status FROM purchased_packages
          WHERE id = ? AND active = 1`,
        [purchasedPackageId]
      );
      if (!rows.length) {
        res.status(404).json({ error: "Paquete comprado no encontrado" });
        return;
      }
      const pending = await q<Row>(
        `SELECT id FROM purchased_packages_services
          WHERE id_purchased_package = ? AND active = 1 AND id_status <> ?`,
        [purchasedPackageId, ST_DONE]
      );
      if (pending.length) {
        res.status(400).json({
          error:
            pending.length === 1
              ? "No se puede finalizar: hay 1 servicio sin terminar"
              : `No se puede finalizar: hay ${pending.length} servicios sin terminar`,
        });
        return;
      }
      const price = Number(rows[0].price || 0);
      const paid = Number(rows[0].paid || 0);
      if (paid + 0.01 < price) {
        res.status(400).json({
          error: `No se puede finalizar: el pago está incompleto (faltan ${(
            price - paid
          ).toFixed(2)})`,
        });
        return;
      }
      await exec(
        `UPDATE purchased_packages
            SET id_status = ?, finished_at = NOW()
          WHERE id = ?`,
        [ST_FINISHED, purchasedPackageId]
      );
      res.status(200).json({ ok: true, finished: true });
      return;
    }

    // ---- Reabrir un paquete terminado ----
    if (actionName === "reabrir-paquete") {
      const purchasedPackageId = Number(b.purchasedPackageId || 0);
      if (!purchasedPackageId) {
        res.status(400).json({ error: "Indica el paquete comprado" });
        return;
      }
      const r = await exec(
        `UPDATE purchased_packages
            SET id_status = ?, finished_at = NULL
          WHERE id = ? AND active = 1`,
        [ST_PROCESS, purchasedPackageId]
      );
      if (!r.affectedRows) {
        res.status(404).json({ error: "Paquete comprado no encontrado" });
        return;
      }
      res.status(200).json({ ok: true, finished: false });
      return;
    }

    // ---- Reabrir un servicio terminado ----
    if (actionName === "reabrir-servicio") {
      const serviceId = Number(b.serviceId || 0);
      if (!serviceId) {
        res.status(400).json({ error: "Falta el servicio" });
        return;
      }
      const r = await exec(
        `UPDATE purchased_packages_services
            SET id_status = ?, finished_at = NULL
          WHERE id = ? AND active = 1`,
        [ST_PROCESS, serviceId]
      );
      if (!r.affectedRows) {
        res.status(404).json({ error: "Servicio no encontrado" });
        return;
      }
      res.status(200).json({ ok: true });
      return;
    }

    // ---- Quitar un movimiento o un abono ----
    if (actionName === "quitar-movimiento") {
      const movementId = Number(b.movementId || 0);
      if (!movementId) {
        res.status(400).json({ error: "Falta el movimiento" });
        return;
      }
      const source = norm(b.source) === "payment" ? "payment" : "movement";
      if (source === "payment") {
        const found = await q<Row>(
          `SELECT id_purchased_package FROM purchased_packages_payments
            WHERE id = ? AND active = 1`,
          [movementId]
        );
        if (!found.length) {
          res.status(404).json({ error: "Abono no encontrado" });
          return;
        }
        const purchasedPackageId = Number(found[0].id_purchased_package || 0);
        const paid = await transaccion(async (conn) => {
          await conn.query(
            `UPDATE purchased_packages_payments SET active = 0 WHERE id = ?`,
            [movementId]
          );
          return purchasedPackageId
            ? await recomputePaid(conn, purchasedPackageId)
            : 0;
        });
        res.status(200).json({ ok: true, paid });
        return;
      }
      const r = await exec(
        `UPDATE purchased_packages_movements SET active = 0 WHERE id = ?`,
        [movementId]
      );
      if (!r.affectedRows) {
        res.status(404).json({ error: "Movimiento no encontrado" });
        return;
      }
      res.status(200).json({ ok: true });
      return;
    }

    // ---- Servicios: actualizar descripción / completar ----
    if (actionName === "actualizar-servicio" || actionName === "completar-servicio") {
      const serviceId = Number(b.serviceId || 0);
      if (!serviceId) {
        res.status(400).json({ error: "Falta el servicio" });
        return;
      }
      const fields: string[] = [];
      const params: unknown[] = [];
      if (b.description !== undefined) {
        fields.push("`description` = ?");
        params.push(norm(b.description) || null);
      }
      if (actionName === "completar-servicio") {
        fields.push("`id_status` = ?", "`finished_at` = NOW()");
        params.push(ST_DONE);
      }
      if (!fields.length) {
        res.status(400).json({ error: "Nada que actualizar" });
        return;
      }
      const r = await exec(
        `UPDATE purchased_packages_services
            SET ${fields.join(", ")}
          WHERE id = ? AND active = 1`,
        [...params, serviceId]
      );
      if (!r.affectedRows) {
        res.status(404).json({ error: "Servicio no encontrado" });
        return;
      }
      res.status(200).json({ ok: true });
      return;
    }

    // ---- Abonar (tabla de payments: mantiene `paid` cuadrado) ----
    if (actionName === "abonar") {
      const purchasedPackageId = Number(b.purchasedPackageId || 0);
      const amount = asAmount(b.amount);
      if (!purchasedPackageId) {
        res.status(400).json({ error: "Indica el paquete comprado" });
        return;
      }
      if (amount === null) {
        res.status(400).json({ error: "El monto del abono debe ser mayor a 0" });
        return;
      }
      const exists = await q(
        `SELECT id FROM purchased_packages WHERE id = ? AND active = 1`,
        [purchasedPackageId]
      );
      if (!exists.length) {
        res.status(404).json({ error: "Paquete comprado no encontrado" });
        return;
      }
      const description = norm(b.description);
      const out = await transaccion(async (conn) => {
        const [ins]: any[] = await conn.query(
          `INSERT INTO purchased_packages_payments
             (id_purchased_package, amount, description)
           VALUES (?, ?, ?)`,
          [purchasedPackageId, amount, description || null]
        );
        const paid = await recomputePaid(conn, purchasedPackageId);
        return { id: Number(ins.insertId), paid };
      });
      res.status(201).json({ ok: true, ...out });
      return;
    }

    // ---- Movimiento propio: inversión, gasto o abono externo ----
    if (actionName === "movimiento") {
      const purchasedPackageId = Number(b.purchasedPackageId || 0);
      const kind = asKind(b.kind);
      const amount = asAmount(b.amount);
      if (!purchasedPackageId) {
        res.status(400).json({ error: "Indica el paquete comprado" });
        return;
      }
      if (!kind) {
        res.status(400).json({ error: "Tipo de movimiento inválido" });
        return;
      }
      if (amount === null) {
        res.status(400).json({ error: "El monto debe ser mayor a 0" });
        return;
      }
      const exists = await q(
        `SELECT id FROM purchased_packages WHERE id = ? AND active = 1`,
        [purchasedPackageId]
      );
      if (!exists.length) {
        res.status(404).json({ error: "Paquete comprado no encontrado" });
        return;
      }
      const description = norm(b.description);
      const r = await exec(
        `INSERT INTO purchased_packages_movements
           (id_purchased_package, kind, amount, description)
         VALUES (?, ?, ?, ?)`,
        [purchasedPackageId, kind, amount, description || null]
      );
      res.status(201).json({ ok: true, id: r.insertId, kind, amount });
      return;
    }

    res.status(400).json({ error: "Acción no reconocida" });
  } catch (e) {
    console.error("[admin/package-progress]", e);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});
