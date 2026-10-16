import type { NextApiRequest, NextApiResponse } from "next";
import type { PoolConnection } from "mysql2/promise";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { ok, created, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";
import { q, exec, transaccion } from "../../../lib/db";
import {
  drivePathsOverlap,
  packageClientIds,
  packageDrivePaths,
  sharedDriveConflict,
  userDrivePaths,
  userSharedConflict,
} from "../../../lib/drive-paths";
import {
  saveServiceShare,
  serviceSharesByIds,
} from "../../../lib/service-shares";

// ==================================================================
// ADMINISTRACIÓN DEL PAQUETE DEL CLIENTE -> /api/admin/package-progress
//
//   GET  ?purchasedPackageId=N
//        { package, services, movements, totals, canFinish, blockers }
//
//   POST  { action, ... }
//     abonar              { purchasedPackageId, amount, description }
//     movimiento          { purchasedPackageId, kind, amount, description }
//       kind = inversion | gasto | ahorro | abono_externo
//     editar-movimiento   { movementId, source, kind?, amount?, description? }
//       Solo si el paquete NO está finalizado. En un abono (source
//       'payment') se recalcula `paid`; en un movimiento propio se puede
//       cambiar el tipo, el monto y el concepto.
//     quitar-movimiento   { movementId, source }
//     completar-servicio  { serviceId, description? }
//     reabrir-servicio    { serviceId }
//     actualizar-servicio { serviceId, description }
//     actualizar-servicio-url { serviceId, url }  (liga del Drive del servicio)
//     actualizar-servicio-share { serviceId, folder, link } (carpeta y liga
//       compartidas de UN servicio del paquete)
//     agregar-directorio  { purchasedPackageId, path }
//       Suma UNA carpeta del Drive a las compartidas con el cliente (el
//       paquete puede compartir varias).
//     quitar-directorio   { purchasedPackageId, path }
//       Deja de compartir esa carpeta.
//     agregar-directorio-cliente { purchasedPackageId, path }
//       Suma UNA carpeta compartida DIRECTAMENTE con el CLIENTE (no con el
//       paquete): aparece en TODOS sus paquetes. Requiere la migración
//       2026-10-17 (columna `id_user` en purchased_packages_drive).
//     quitar-directorio-cliente { purchasedPackageId, path }
//       Deja de compartir esa carpeta del cliente.
//     compartir-directorio { purchasedPackageId, path }
//       Compatibilidad: deja UNA sola carpeta compartida ('' = ninguna).
//     finalizar           { purchasedPackageId }
//     reabrir-paquete     { purchasedPackageId }
//
// Requiere la migración 2026-10-12_package_admin.sql:
//   * purchased_packages_movements (varchar: inversion | gasto | ahorro |
//     abono_externo; el tipo nuevo no necesita migración)
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
const MOVEMENT_KINDS = [
  "inversion",
  "gasto",
  "ahorro",
  "abono_externo",
  // Pago repartido a un colaborador o empleado. Cuenta como gasto, pero se
  // etiqueta aparte para poder ver a quién se le pagó.
  "pago",
] as const;
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

/**
 * Interruptor que llega del panel (`true`/`1`/`"1"`). Si no viene, [fallback]:
 * así un panel viejo que no manda la opción no la apaga sin querer.
 */
function asOption(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;
  const n = Number(raw);
  return Number.isFinite(n) ? n === 1 : fallback;
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

/**
 * Colaboradores y empleados activos: únicos destinatarios de un pago
 * repartido. Devuelve [] (sin romper la petición) si la consulta falla.
 */
async function loadRecipients(): Promise<Row[]> {
  try {
    return await q<Row>(
      `SELECT u.id, CONCAT_WS(' ', u.name, u.lastname) AS name, r.name AS role_name
         FROM users u
         JOIN roles r ON r.id = u.id_role
        WHERE u.active = 1 AND r.active = 1
          AND LOWER(r.name) IN ('colaborador', 'empleado')
        ORDER BY r.name ASC, u.name ASC`
    );
  } catch (e) {
    console.error("[admin/package-progress] destinatarios:", e);
    return [];
  }
}

// ¿`purchased_packages_movements` ya tiene la columna `id_user`? Se detecta
// una sola vez por proceso: si la migración todavía no se aplicó, los
// movimientos se guardan igual (sin destinatario) en vez de romper el alta.
let movementsHaveUserColumn: boolean | null = null;

/** Inserta un movimiento, con destinatario si la columna existe. */
async function insertMovementSafe(args: {
  purchasedPackageId: number;
  kind: string;
  amount: number;
  description?: string;
  userId?: number | null;
}): Promise<{ insertId: number }> {
  const { purchasedPackageId, kind, amount, description, userId } = args;
  if (userId && movementsHaveUserColumn !== false) {
    try {
      const r = await exec(
        `INSERT INTO purchased_packages_movements
           (id_purchased_package, kind, amount, description, id_user)
         VALUES (?, ?, ?, ?, ?)`,
        [purchasedPackageId, kind, amount, description || null, userId]
      );
      movementsHaveUserColumn = true;
      return { insertId: Number(r.insertId) };
    } catch (e) {
      if (movementsHaveUserColumn === true) throw e;
      movementsHaveUserColumn = false;
      console.error(
        "[admin/package-progress] id_user no disponible en movimientos:",
        e
      );
    }
  }
  const r = await exec(
    `INSERT INTO purchased_packages_movements
       (id_purchased_package, kind, amount, description)
     VALUES (?, ?, ?, ?)`,
    [purchasedPackageId, kind, amount, description || null]
  );
  return { insertId: Number(r.insertId) };
}

/** Normaliza una ruta del Drive ('' si no queda nada útil). */
function cleanDrivePath(raw: unknown): string {
  return norm(raw)
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s !== "" && s !== "." && s !== "..")
    .join("/");
}

/** Sincroniza la columna vieja `drive_path` con la PRIMERA carpeta. */
async function syncLegacyDrivePath(
  purchasedPackageId: number,
  paths: string[]
): Promise<void> {
  try {
    await exec(
      `UPDATE purchased_packages SET drive_path = ? WHERE id = ?`,
      [paths[0] ?? null, purchasedPackageId]
    );
  } catch {
    // Migración pendiente de la columna vieja: la tabla nueva ya tiene todo.
  }
}

/**
 * Deja EXACTAMENTE [paths] como las carpetas del Drive compartidas con el
 * cliente de ese paquete (tabla `purchased_packages_drive` + columna vieja).
 *
 * Devuelve 'missing' si el paquete no existe y 'no-table' si la migración
 * todavía no se aplicó (se deja al menos la columna vieja al día).
 */
async function setPackageDriveFolders(
  purchasedPackageId: number,
  paths: string[]
): Promise<"ok" | "missing" | "no-table"> {
  const exists = await q(
    `SELECT id FROM purchased_packages WHERE id = ? AND active = 1`,
    [purchasedPackageId]
  );
  if (!exists.length) return "missing";
  try {
    await transaccion(async (conn) => {
      await conn.query(
        `UPDATE purchased_packages_drive
            SET active = 0
          WHERE id_purchased_package = ? AND active = 1`,
        [purchasedPackageId]
      );
      for (const p of paths) {
        await conn.query(
          `INSERT INTO purchased_packages_drive (id_purchased_package, path)
           VALUES (?, ?)`,
          [purchasedPackageId, p]
        );
      }
    });
  } catch {
    await syncLegacyDrivePath(purchasedPackageId, paths);
    return "no-table";
  }
  await syncLegacyDrivePath(purchasedPackageId, paths);
  return "ok";
}

/** Totales por tipo de movimiento + abonado. */
function sumBy(rows: Row[], predicate: (r: Row) => boolean): number {
  return rows
    .filter(predicate)
    .reduce((a, r) => a + Number(r.amount || 0), 0);
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  const action = req.method === "GET" ? "read" : "update";
  if (req.method !== "GET" && req.method !== "POST") {
    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
    return;
  }
  const me = await requirePermission(req, res, "clientes", action);
  if (!me) return;

  try {
    // ================================ GET ================================
    if (req.method === "GET") {
      const purchasedPackageId = Number(req.query.purchasedPackageId || 0);
      if (!purchasedPackageId) {
        fail(res, 400, "Falta purchasedPackageId", "Indica de qué paquete quieres el detalle");
        return;
      }
      let pkgRows: Row[];
      try {
        pkgRows = await q<Row>(
          `SELECT pp.id, pp.name, pp.price, pp.paid, pp.id_status, pp.drive_path,
                  st.name AS status_name,
                  DATE_FORMAT(pp.finished_at, '%Y-%m-%dT%H:%i:%s') AS finished_at
             FROM purchased_packages pp
             LEFT JOIN status st ON st.id = pp.id_status
            WHERE pp.id = ? AND pp.active = 1`,
          [purchasedPackageId]
        );
      } catch {
        // Migración 2026-10-15 (carpeta compartida) aún no aplicada.
        pkgRows = await q<Row>(
          `SELECT pp.id, pp.name, pp.price, pp.paid, pp.id_status,
                  st.name AS status_name,
                  DATE_FORMAT(pp.finished_at, '%Y-%m-%dT%H:%i:%s') AS finished_at
             FROM purchased_packages pp
             LEFT JOIN status st ON st.id = pp.id_status
            WHERE pp.id = ? AND pp.active = 1`,
          [purchasedPackageId]
        );
      }
      if (!pkgRows.length) {
        fail(res, 404, "Paquete comprado no encontrado", `No hay un paquete con id ${purchasedPackageId}`);
        return;
      }

      let services: Row[];
      try {
        services = await q<Row>(
          `SELECT pps.id, pps.id_service, pps.description, pps.id_status,
                  st.name AS status_name,
                  DATE_FORMAT(pps.finished_at, '%Y-%m-%dT%H:%i:%s') AS finished_at,
                  s.name AS service_name, s.icon AS service_icon, s.url AS service_url
             FROM purchased_packages_services pps
             LEFT JOIN services s ON s.id = pps.id_service
             LEFT JOIN status st ON st.id = pps.id_status
            WHERE pps.id_purchased_package = ? AND pps.active = 1
            ORDER BY pps.id ASC`,
          [purchasedPackageId]
        );
      } catch {
        // Migración 2026-10-13_services_url.sql aún no aplicada: sin ligas.
        services = await q<Row>(
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
      }

      // Opciones de compartir por SERVICIO (carpeta, liga y elementos que
      // marcó el cliente). Sin migración quedan vacías.
      const shares = await serviceSharesByIds(services.map((s) => Number(s.id)));

      // Movimientos = abonos (payments) + movimientos propios. Si la
      // migración aún no se aplicó, el modal sigue funcionando sin ellos.
      let movements: Row[] = [];
      let movementsAvailable = true;
      try {
        // El `kind` sale del UNION: los abonos son 'abono' y los
        // movimientos propios conservan su tipo (antes TODOS salían como
        // 'abono', así que un gasto nunca se contaba como gasto y todo se
        // colaba en el total abonado).
        //
        // Los movimientos propios llevan `id_user` (a quién se le pagó o
        // quién lo registró). Si esa columna todavía no existe (migración
        // pendiente) se cae a la consulta anterior para no perder la lista.
        const baseQuery = (withUser: boolean) =>
          `SELECT id, kind, amount, description, source, created,
                  user_id, user_name
             FROM (
               SELECT id, 'abono' AS kind, amount, description,
                      'payment' AS source,
                      DATE_FORMAT(created, '%Y-%m-%dT%H:%i:%s') AS created,
                      NULL AS user_id, NULL AS user_name
                 FROM purchased_packages_payments
                WHERE id_purchased_package = ? AND active = 1
               UNION ALL
               SELECT mv.id, mv.kind, mv.amount, mv.description,
                      'movement' AS source,
                      DATE_FORMAT(mv.created, '%Y-%m-%dT%H:%i:%s') AS created,${
                        withUser
                          ? " mv.id_user AS user_id, CONCAT_WS(' ', u.name, u.lastname) AS user_name"
                          : " NULL AS user_id, NULL AS user_name"
                      }
                 FROM purchased_packages_movements mv${
                   withUser ? " LEFT JOIN users u ON u.id = mv.id_user" : ""
                 }
                WHERE mv.id_purchased_package = ? AND mv.active = 1
             ) m
            ORDER BY m.created DESC, m.id DESC`;
        try {
          movements = await q<Row>(baseQuery(true), [
            purchasedPackageId,
            purchasedPackageId,
          ]);
        } catch {
          movements = await q<Row>(baseQuery(false), [
            purchasedPackageId,
            purchasedPackageId,
          ]);
        }
      } catch (e) {
        movementsAvailable = false;
        console.error("[admin/package-progress] movimientos:", e);
      }

      // Colaboradores y empleados activos: únicos destinatarios del reparto.
      const recipients = await loadRecipients();

      // Carpetas compartidas de ESTE paquete (puede tener varias).
      const sharedPaths = await packageDrivePaths(purchasedPackageId);
      // Carpetas compartidas DIRECTAMENTE con el CLIENTE: se ven en TODOS sus
      // paquetes (vacío si la migración 2026-10-17 todavía no se aplicó).
      const clientIds = await packageClientIds(purchasedPackageId);
      const clientPaths: string[] = [];
      for (const cid of clientIds) {
        for (const p of await userDrivePaths(cid)) {
          if (!clientPaths.includes(p)) clientPaths.push(p);
        }
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
          // Carpetas del Drive COMPARTIDAS con el cliente de este paquete
          // (vacío = todavía no se le comparte ninguna). Se administran en la
          // pestaña Drive del administrador del paquete. `drivePath` sigue
          // siendo la PRIMERA carpeta (compatibilidad con lo ya existente).
          drivePath: sharedPaths[0] || "",
          drivePaths: sharedPaths,
          // Carpetas compartidas con el CLIENTE (todos sus paquetes).
          clientDrivePaths: clientPaths,
          clientIds,
        },
        services: services.map((s) => {
          const share = shares.get(Number(s.id));
          return {
            id: Number(s.id),
            serviceId: Number(s.id_service || 0),
            name: String(s.service_name || "Servicio"),
            icon: String(s.service_icon || ""),
            url: String(s.service_url || ""),
            // Opciones de compartir del SERVICIO (carpeta y liga propias del
            // servicio del paquete), QUÉ le sale al cliente (elegir fotos y
            // abrir carpeta) y cuántos elementos marcó.
            shareFolder: share?.folder ?? "",
            shareLink: share?.link ?? "",
            pickPhotos: share?.pickPhotos ?? false,
            showFolder: share?.showFolder ?? true,
            items: share?.items ?? 0,
            description: String(s.description || ""),
            status: String(s.status_name || "Pendiente"),
            statusId: Number(s.id_status || 0),
            done: Number(s.id_status) === ST_DONE,
            finishedAt: s.finished_at || null,
          };
        }),
        movements: movements.map((m) => ({
          id: Number(m.id),
          kind: String(m.kind || "gasto"),
          source: String(m.source || "movement"),
          amount: Number(m.amount || 0),
          description: String(m.description || ""),
          created: m.created || "",
          // Destinatario del pago (solo movimientos propios).
          userId: m.user_id == null ? null : Number(m.user_id),
          userName: String(m.user_name || ""),
        })),
        // A quién se le puede repartir un pago: colaboradores y empleados.
        recipients: recipients.map((u) => ({
          id: Number(u.id),
          name: String(u.name || "").trim() || `Usuario #${Number(u.id)}`,
          roleName: String(u.role_name || ""),
        })),
        movementsAvailable,
        // Estos totales son SOLO informativos de la pestaña Movimientos:
        // gastos, inversiones, ahorros y abonos externos NO tocan `paid`
        // (abonado) ni el saldo, que siguen saliendo de
        // purchased_packages_payments.
        totals: (() => {
          const round2 = (n: number) => Math.round(n * 100) / 100;
          const abonado = sumBy(movements, (m) => m.kind === "abono");
          const invertido = sumBy(movements, (m) => m.kind === "inversion");
          // Los PAGOS a colaboradores/empleados se REGISTRAN (para saber a
          // quién se le pagó y cuánto) pero son un gasto INVISIBLE: no se
          // descuentan del paquete ni de su disponible.
          const pagos = sumBy(movements, (m) => m.kind === "pago");
          // Inversión = un tipo de gasto: "Gastado" incluye ambos (sin pagos).
          const gastado =
            sumBy(movements, (m) => m.kind === "gasto") + invertido;
          return {
            abonado,
            invertido,
            gastado,
            pagos,
            ahorrado: sumBy(movements, (m) => m.kind === "ahorro"),
            abonoExterno: sumBy(movements, (m) => m.kind === "abono_externo"),
            // DISPONIBLE = abonado - gastado (gasto + inversión) - ahorro +
            // abono externo. El AHORRO se aparta (sale del disponible) y el
            // ABONO EXTERNO es dinero que entra por fuera del paquete, así
            // que se suma. Es el dinero libre y la BASE del ahorro en
            // porcentaje que ofrece el panel.
            disponible: Math.max(
              0,
              round2(
                abonado -
                  gastado -
                  sumBy(movements, (m) => m.kind === "ahorro") +
                  sumBy(movements, (m) => m.kind === "abono_externo")
              )
            ),
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
        fail(res, 400, "Indica el paquete comprado", "La acción necesita el paquete del cliente");
        return;
      }
      const rows = await q<Row>(
        `SELECT id, price, paid, id_status FROM purchased_packages
          WHERE id = ? AND active = 1`,
        [purchasedPackageId]
      );
      if (!rows.length) {
        fail(res, 404, "Paquete comprado no encontrado", `No hay un paquete con id ${purchasedPackageId}`);
        return;
      }
      const pending = await q<Row>(
        `SELECT id FROM purchased_packages_services
          WHERE id_purchased_package = ? AND active = 1 AND id_status <> ?`,
        [purchasedPackageId, ST_DONE]
      );
      if (pending.length) {
        fail(
          res,
          400,
          "No se puede finalizar el paquete",
          pending.length === 1
            ? "Hay 1 servicio sin terminar"
            : `Hay ${pending.length} servicios sin terminar`
        );
        return;
      }
      const price = Number(rows[0].price || 0);
      const paid = Number(rows[0].paid || 0);
      if (paid + 0.01 < price) {
        fail(
          res,
          400,
          "No se puede finalizar el paquete",
          `El pago está incompleto: faltan ${(price - paid).toFixed(2)}`
        );
        return;
      }
      await exec(
        `UPDATE purchased_packages
            SET id_status = ?, finished_at = NOW()
          WHERE id = ?`,
        [ST_FINISHED, purchasedPackageId]
      );
      await logActivity({
        userId: me.sub,
        module: "clientes",
        moduleName: "Clientes",
        action: "update",
        entity: "paquete-cliente",
        entityId: purchasedPackageId,
        description: "Paquete finalizado exitosamente",
        details: { purchasedPackageId, finished: true },
        req,
      });
      ok(res, "Paquete finalizado exitosamente", {
        finished: true,
        item: { purchasedPackageId, finished: true },
      });
      return;
    }

    // ---- Reabrir un paquete terminado ----
    if (actionName === "reabrir-paquete") {
      const purchasedPackageId = Number(b.purchasedPackageId || 0);
      if (!purchasedPackageId) {
        fail(res, 400, "Indica el paquete comprado", "La acción necesita el paquete del cliente");
        return;
      }
      const r = await exec(
        `UPDATE purchased_packages
            SET id_status = ?, finished_at = NULL
          WHERE id = ? AND active = 1`,
        [ST_PROCESS, purchasedPackageId]
      );
      if (!r.affectedRows) {
        fail(res, 404, "Paquete comprado no encontrado", `No hay un paquete con id ${purchasedPackageId}`);
        return;
      }
      await logActivity({
        userId: me.sub,
        module: "clientes",
        moduleName: "Clientes",
        action: "update",
        entity: "paquete-cliente",
        entityId: purchasedPackageId,
        description: "Paquete reabierto exitosamente",
        details: { purchasedPackageId, finished: false },
        req,
      });
      ok(res, "Paquete reabierto exitosamente", {
        finished: false,
        item: { purchasedPackageId, finished: false },
      });
      return;
    }

    // ---- Reabrir un servicio terminado ----
    if (actionName === "reabrir-servicio") {
      const serviceId = Number(b.serviceId || 0);
      if (!serviceId) {
        fail(res, 400, "Falta el servicio", "Indica qué servicio del paquete quieres reabrir");
        return;
      }
      const r = await exec(
        `UPDATE purchased_packages_services
            SET id_status = ?, finished_at = NULL
          WHERE id = ? AND active = 1`,
        [ST_PROCESS, serviceId]
      );
      if (!r.affectedRows) {
        fail(res, 404, "Servicio no encontrado", `No hay un servicio activo con id ${serviceId}`);
        return;
      }
      await logActivity({
        userId: me.sub,
        module: "clientes",
        moduleName: "Clientes",
        action: "update",
        entity: "servicio-paquete",
        entityId: serviceId,
        description: "Servicio reabierto exitosamente",
        details: { serviceId },
        req,
      });
      ok(res, "Servicio reabierto exitosamente", { item: { serviceId } });
      return;
    }

    // ---- Editar un movimiento o un abono (paquete NO finalizado) ----
    if (actionName === "editar-movimiento") {
      const movementId = Number(b.movementId || 0);
      if (!movementId) {
        fail(res, 400, "Falta el movimiento", "Indica qué movimiento quieres editar");
        return;
      }
      const source = norm(b.source) === "payment" ? "payment" : "movement";
      const table =
        source === "payment"
          ? "purchased_packages_payments"
          : "purchased_packages_movements";
      const found = await q<Row>(
        `SELECT m.id_purchased_package, pp.id_status
           FROM ${table} m
           JOIN purchased_packages pp ON pp.id = m.id_purchased_package
          WHERE m.id = ? AND m.active = 1`,
        [movementId]
      );
      if (!found.length) {
        fail(
          res,
          404,
          source === "payment" ? "Abono no encontrado" : "Movimiento no encontrado",
          `No hay un registro activo con id ${movementId}`
        );
        return;
      }
      // El historial de un paquete terminado es solo de consulta.
      if (Number(found[0].id_status) === ST_FINISHED) {
        fail(
          res,
          400,
          "El paquete está finalizado",
          "Reábrelo para poder editar sus movimientos"
        );
        return;
      }
      const fields: string[] = [];
      const params: unknown[] = [];
      if (b.amount !== undefined) {
        const amount = asAmount(b.amount);
        if (amount === null) {
          fail(res, 400, "El monto debe ser mayor a 0", "Escribe un monto válido");
          return;
        }
        fields.push("`amount` = ?");
        params.push(amount);
      }
      if (b.description !== undefined) {
        fields.push("`description` = ?");
        params.push(norm(b.description) || null);
      }
      if (source === "movement" && b.kind !== undefined) {
        const kind = asKind(b.kind);
        if (!kind) {
          fail(res, 400, "Tipo de movimiento inválido", String(b.kind));
          return;
        }
        fields.push("`kind` = ?");
        params.push(kind);
      }
      if (!fields.length) {
        fail(res, 400, "Nada que actualizar", "No enviaste ningún campo del movimiento");
        return;
      }
      const purchasedPackageId = Number(found[0].id_purchased_package || 0);
      const paid = await transaccion(async (conn) => {
        await conn.query(
          `UPDATE ${table} SET ${fields.join(", ")} WHERE id = ?`,
          [...params, movementId]
        );
        // Un abono alimenta `paid`: hay que recuadrarlo.
        if (source === "payment" && purchasedPackageId) {
          return await recomputePaid(conn, purchasedPackageId);
        }
        return 0;
      });
      await logActivity({
        userId: me.sub,
        module: "clientes",
        moduleName: "Clientes",
        action: "update",
        entity: source === "payment" ? "abono" : "movimiento",
        entityId: movementId,
        description:
          source === "payment"
            ? "Abono actualizado exitosamente"
            : "Movimiento actualizado exitosamente",
        details: { id: movementId, purchase: purchasedPackageId, ...b },
        req,
      });
      ok(res, "Movimiento actualizado exitosamente", {
        paid,
        item: { id: movementId, paid },
      });
      return;
    }

    // ---- Quitar un movimiento o un abono ----
    if (actionName === "quitar-movimiento") {
      const movementId = Number(b.movementId || 0);
      if (!movementId) {
        fail(res, 400, "Falta el movimiento", "Indica qué movimiento quieres quitar");
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
          fail(res, 404, "Abono no encontrado", `No hay un abono activo con id ${movementId}`);
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
        await logActivity({
          userId: me.sub,
          module: "clientes",
          moduleName: "Clientes",
          action: "delete",
          entity: "abono",
          entityId: movementId,
          description: "Abono eliminado exitosamente",
          details: { id: movementId, purchase: purchasedPackageId, paid },
          req,
        });
        ok(res, "Abono eliminado exitosamente", { paid, item: { id: movementId, paid } });
        return;
      }
      const r = await exec(
        `UPDATE purchased_packages_movements SET active = 0 WHERE id = ?`,
        [movementId]
      );
      if (!r.affectedRows) {
        fail(res, 404, "Movimiento no encontrado", `No hay un movimiento activo con id ${movementId}`);
        return;
      }
      await logActivity({
        userId: me.sub,
        module: "clientes",
        moduleName: "Clientes",
        action: "delete",
        entity: "movimiento",
        entityId: movementId,
        description: "Movimiento eliminado exitosamente",
        details: { id: movementId },
        req,
      });
      ok(res, "Movimiento eliminado exitosamente", { item: { id: movementId } });
      return;
    }

    // ---- Servicios: actualizar descripción / completar ----
    if (actionName === "actualizar-servicio" || actionName === "completar-servicio") {
      const serviceId = Number(b.serviceId || 0);
      if (!serviceId) {
        fail(res, 400, "Falta el servicio", "Indica qué servicio del paquete quieres actualizar");
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
        fail(res, 400, "Nada que actualizar", "No enviaste ningún campo del servicio");
        return;
      }
      const r = await exec(
        `UPDATE purchased_packages_services
            SET ${fields.join(", ")}
          WHERE id = ? AND active = 1`,
        [...params, serviceId]
      );
      if (!r.affectedRows) {
        fail(res, 404, "Servicio no encontrado", `No hay un servicio activo con id ${serviceId}`);
        return;
      }
      const done = actionName === "completar-servicio";
      const message = done
        ? "Servicio marcado como terminado exitosamente"
        : "Servicio actualizado exitosamente";
      await logActivity({
        userId: me.sub,
        module: "clientes",
        moduleName: "Clientes",
        action: "update",
        entity: "servicio-paquete",
        entityId: serviceId,
        description: message,
        details: { serviceId, done, ...b },
        req,
      });
      ok(res, message, { item: { serviceId, done } });
      return;
    }

    // ---- URL (liga base del Drive) de un servicio del catálogo ----
    // Se administra DESDE la pestaña Servicios del paquete comprado.
    if (actionName === "actualizar-servicio-url") {
      const serviceId = Number(b.serviceId || 0);
      if (!serviceId) {
        fail(res, 400, "Falta el servicio", "Indica de qué servicio quieres guardar la liga");
        return;
      }
      const url = norm(b.url);
      const r = await exec(`UPDATE services SET url = ? WHERE id = ?`, [
        url || null,
        serviceId,
      ]);
      if (!r.affectedRows) {
        fail(res, 404, "Servicio no encontrado", `No hay un servicio activo con id ${serviceId}`);
        return;
      }
      await logActivity({
        userId: me.sub,
        module: "services",
        moduleName: "Servicios",
        action: "update",
        entity: "servicio",
        entityId: serviceId,
        description: "Liga del servicio actualizada exitosamente",
        details: { serviceId, url },
        req,
      });
      ok(res, "Liga del servicio actualizada exitosamente", {
        item: { serviceId, url },
      });
      return;
    }

    // ---- Opciones de compartir de un servicio del PAQUETE ----
    // `folder` = carpeta del Drive compartida para ESE servicio y `link` = la
    // liga (si las hay). Junto con la selección que marca el cliente forman
    // las opciones de compartir del servicio (migración
    // purchased_packages_services_shares).
    //
    // `pickPhotos` y `showFolder` deciden QUÉ le sale al cliente en «Mi
    // paquete»: elegir fotos (antes salía en TODOS los servicios) y abrir la
    // carpeta. Los enciende el estudio servicio por servicio.
    if (actionName === "actualizar-servicio-share") {
      const serviceId = Number(b.serviceId || 0);
      if (!serviceId) {
        fail(res, 400, "Falta el servicio", "Indica qué servicio del paquete quieres compartir");
        return;
      }
      const folder = norm(b.folder);
      const link = norm(b.link);
      const pickPhotos = asOption(b.pickPhotos, false);
      const showFolder = asOption(b.showFolder, true);
      const exists = await q(
        `SELECT id FROM purchased_packages_services
          WHERE id = ? AND active = 1`,
        [serviceId]
      );
      if (!exists.length) {
        fail(res, 404, "Servicio no encontrado", `No hay un servicio activo con id ${serviceId}`);
        return;
      }
      try {
        await saveServiceShare(serviceId, folder, link, pickPhotos, showFolder);
      } catch {
        fail(
          res,
          500,
          "Falta aplicar la migración de servicios",
          "La tabla purchased_packages_services_shares no existe todavía"
        );
        return;
      }
      await logActivity({
        userId: me.sub,
        module: "clientes",
        moduleName: "Clientes",
        action: "update",
        entity: "servicio-paquete-share",
        entityId: serviceId,
        description: "Opciones de compartir del servicio actualizadas exitosamente",
        details: { serviceId, folder, link, pickPhotos, showFolder },
        req,
      });
      ok(res, "Opciones de compartir actualizadas exitosamente", {
        item: { serviceId, folder, link, pickPhotos, showFolder },
      });
      return;
    }

    // ---- Abonar (tabla de payments: mantiene `paid` cuadrado) ----
    if (actionName === "abonar") {
      const purchasedPackageId = Number(b.purchasedPackageId || 0);
      const amount = asAmount(b.amount);
      if (!purchasedPackageId) {
        fail(res, 400, "Indica el paquete comprado", "El abono debe pertenecer a un paquete del cliente");
        return;
      }
      if (amount === null) {
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
      await logActivity({
        userId: me.sub,
        module: "clientes",
        moduleName: "Clientes",
        action: "create",
        entity: "abono",
        entityId: out.id,
        description: "Abono registrado exitosamente",
        details: { ...out, purchasedPackageId, amount, description },
        req,
      });
      created(res, "Abono registrado exitosamente", {
        ...out,
        item: { id: out.id, purchasedPackageId, amount },
      });
      return;
    }

    // ---- Agregar UNA carpeta del Drive a las compartidas del paquete ----
    // Un paquete puede compartir VARIAS carpetas. La ruta se normaliza (sin
    // barras iniciales/finales y sin '..') y NO se permite que se solape con
    // otra ya compartida a los mismos clientes: sería el mismo contenido dos
    // veces.
    if (actionName === "agregar-directorio") {
      const purchasedPackageId = Number(b.purchasedPackageId || 0);
      if (!purchasedPackageId) {
        fail(res, 400, "Indica el paquete comprado", "La acción necesita el paquete del cliente");
        return;
      }
      const clean = cleanDrivePath(b.path);
      if (!clean) {
        fail(res, 400, "Elige una carpeta del Drive", "La acción necesita la carpeta que se va a compartir");
        return;
      }
      // ¿Ya está (o se solapa con otra) en ESTE paquete?
      const current = await packageDrivePaths(purchasedPackageId);
      const own = current.find((p) => drivePathsOverlap(clean, p));
      if (own) {
        fail(
          res,
          409,
          "Esa carpeta ya está compartida",
          `«${own}» ya se comparte con el cliente en este paquete ` +
            `(o contiene a «${clean}»). Comparte solo una de las dos.`
        );
        return;
      }
      // Choque con otra carpeta compartida en OTRO paquete del cliente.
      const clash = await sharedDriveConflict(purchasedPackageId, clean);
      if (clash) {
        fail(
          res,
          409,
          "Esa carpeta se solapa con una ya compartida",
          `«${clash}» ya está compartida con el cliente y contiene a «${clean}» ` +
            `(o está dentro de ella). Comparte solo una de las dos para no ` +
            `duplicar el mismo contenido.`
        );
        return;
      }
      const next = [...current, clean];
      const saved = await setPackageDriveFolders(purchasedPackageId, next);
      if (saved === "missing") {
        fail(res, 404, "Paquete comprado no encontrado", `No hay un paquete con id ${purchasedPackageId}`);
        return;
      }
      await logActivity({
        userId: me.sub,
        module: "clientes",
        moduleName: "Clientes",
        action: "update",
        entity: "paquete-cliente",
        entityId: purchasedPackageId,
        description: "Carpeta compartida con el cliente exitosamente",
        details: { purchasedPackageId, drivePaths: next },
        req,
      });
      ok(res, "Carpeta compartida con el cliente exitosamente", {
        drivePath: next[0] ?? "",
        drivePaths: next,
        item: { purchasedPackageId, drivePaths: next },
      });
      return;
    }

    // ---- Compartir UNA carpeta DIRECTAMENTE con el CLIENTE ----
    // En vez de atarla a un solo paquete, la carpeta se comparte con el
    // usuario: aparece en TODOS sus paquetes. La fila guarda también el
    // paquete desde el que se compartió (para saber de dónde salió), pero NO
    // cuenta como carpeta PROPIA de ese paquete.
    if (actionName === "agregar-directorio-cliente") {
      const purchasedPackageId = Number(b.purchasedPackageId || 0);
      if (!purchasedPackageId) {
        fail(res, 400, "Indica el paquete comprado", "La acción necesita el paquete del cliente");
        return;
      }
      const clean = cleanDrivePath(b.path);
      if (!clean) {
        fail(res, 400, "Elige una carpeta del Drive", "La acción necesita la carpeta que se va a compartir");
        return;
      }
      const clientIds = await packageClientIds(purchasedPackageId);
      if (!clientIds.length) {
        fail(res, 404, "El paquete no tiene cliente", "No hay a quién compartirle la carpeta");
        return;
      }
      // Sin duplicar contenido: ni con lo ya compartido al cliente ni con lo
      // compartido a sus paquetes.
      const own = await userSharedConflict(clientIds[0], clean);
      if (own) {
        fail(
          res,
          409,
          "Esa carpeta ya está compartida",
          `«${own}» ya se comparte con el cliente (o contiene a «${clean}»). ` +
            `Comparte solo una de las dos.`
        );
        return;
      }
      const clash = await sharedDriveConflict(purchasedPackageId, clean);
      if (clash) {
        fail(
          res,
          409,
          "Esa carpeta se solapa con una ya compartida",
          `«${clash}» ya está compartida con el cliente y contiene a ` +
            `«${clean}» (o está dentro de ella). Comparte solo una.`
        );
        return;
      }
      try {
        await transaccion(async (conn) => {
          for (const cid of clientIds) {
            await conn.query(
              `INSERT INTO purchased_packages_drive
                 (id_purchased_package, id_user, path)
               VALUES (?, ?, ?)`,
              [purchasedPackageId, cid, clean]
            );
          }
        });
      } catch {
        fail(
          res,
          409,
          "No se pudo compartir con el cliente",
          "Falta aplicar la migración 2026-10-17 (carpetas del cliente)"
        );
        return;
      }
      await logActivity({
        userId: me.sub,
        module: "clientes",
        moduleName: "Clientes",
        action: "update",
        entity: "paquete-cliente",
        entityId: purchasedPackageId,
        description: "Carpeta compartida con el cliente exitosamente",
        details: { purchasedPackageId, path: clean, scope: "cliente" },
        req,
      });
      ok(res, "Carpeta compartida con el cliente exitosamente", {
        item: { purchasedPackageId, path: clean },
      });
      return;
    }

    // ---- Dejar de compartir UNA carpeta DEL CLIENTE ----
    if (actionName === "quitar-directorio-cliente") {
      const purchasedPackageId = Number(b.purchasedPackageId || 0);
      const clean = cleanDrivePath(b.path);
      if (!purchasedPackageId || !clean) {
        fail(res, 400, "Faltan datos", "Indica el paquete y la carpeta");
        return;
      }
      const clientIds = await packageClientIds(purchasedPackageId);
      try {
        let removed = 0;
        for (const cid of clientIds) {
          const r = await exec(
            `UPDATE purchased_packages_drive
                SET active = 0
              WHERE id_user = ? AND path = ? AND active = 1`,
            [cid, clean]
          );
          removed += Number(r.affectedRows || 0);
        }
        if (!removed) {
          fail(res, 404, "Carpeta no compartida", `«${clean}» no está compartida con el cliente`);
          return;
        }
      } catch {
        fail(
          res,
          409,
          "No se pudo quitar la carpeta",
          "Falta aplicar la migración 2026-10-17 (carpetas del cliente)"
        );
        return;
      }
      await logActivity({
        userId: me.sub,
        module: "clientes",
        moduleName: "Clientes",
        action: "update",
        entity: "paquete-cliente",
        entityId: purchasedPackageId,
        description: "Se dejó de compartir la carpeta con el cliente exitosamente",
        details: { purchasedPackageId, path: clean, scope: "cliente" },
        req,
      });
      ok(res, "Se dejó de compartir la carpeta con el cliente exitosamente", {
        item: { purchasedPackageId, path: clean },
      });
      return;
    }

    // ---- Dejar de compartir UNA carpeta del paquete ----
    if (actionName === "quitar-directorio") {
      const purchasedPackageId = Number(b.purchasedPackageId || 0);
      if (!purchasedPackageId) {
        fail(res, 400, "Indica el paquete comprado", "La acción necesita el paquete del cliente");
        return;
      }
      const clean = cleanDrivePath(b.path);
      if (!clean) {
        fail(res, 400, "Elige la carpeta", "La acción necesita la carpeta que se deja de compartir");
        return;
      }
      const current = await packageDrivePaths(purchasedPackageId);
      const next = current.filter((p) => p !== clean);
      if (next.length === current.length) {
        fail(res, 404, "Carpeta no compartida", `«${clean}» no está compartida en este paquete`);
        return;
      }
      const saved = await setPackageDriveFolders(purchasedPackageId, next);
      if (saved === "missing") {
        fail(res, 404, "Paquete comprado no encontrado", `No hay un paquete con id ${purchasedPackageId}`);
        return;
      }
      await logActivity({
        userId: me.sub,
        module: "clientes",
        moduleName: "Clientes",
        action: "update",
        entity: "paquete-cliente",
        entityId: purchasedPackageId,
        description: "Se dejó de compartir la carpeta exitosamente",
        details: { purchasedPackageId, drivePath: clean, drivePaths: next },
        req,
      });
      ok(res, "Se dejó de compartir la carpeta exitosamente", {
        drivePath: next[0] ?? "",
        drivePaths: next,
        item: { purchasedPackageId, drivePaths: next },
      });
      return;
    }

    // ---- Carpeta del Drive COMPARTIDA con el cliente del paquete ----
    // COMPATIBILIDAD: deja UNA sola carpeta compartida (`path` vacío = dejar
    // de compartir todas). El panel nuevo usa `agregar-directorio` y
    // `quitar-directorio`, que sí admite varias carpetas por paquete.
    if (actionName === "compartir-directorio") {
      const purchasedPackageId = Number(b.purchasedPackageId || 0);
      if (!purchasedPackageId) {
        fail(res, 400, "Indica el paquete comprado", "La acción necesita el paquete del cliente");
        return;
      }
      const clean = cleanDrivePath(b.path);
      // Choque con otra carpeta ya compartida a los mismos clientes.
      if (clean) {
        const clash = await sharedDriveConflict(purchasedPackageId, clean);
        if (clash) {
          fail(
            res,
            409,
            "Esa carpeta se solapa con una ya compartida",
            `«${clash}» ya está compartida con el cliente y contiene a «${clean}» ` +
              `(o está dentro de ella). Comparte solo una de las dos para no ` +
              `duplicar el mismo contenido.`
          );
          return;
        }
      }
      const saved = await setPackageDriveFolders(
        purchasedPackageId,
        clean ? [clean] : []
      );
      if (saved === "missing") {
        fail(res, 404, "Paquete comprado no encontrado", `No hay un paquete con id ${purchasedPackageId}`);
        return;
      }
      const message = clean
        ? "Carpeta compartida con el cliente exitosamente"
        : "Se dejó de compartir la carpeta exitosamente";
      await logActivity({
        userId: me.sub,
        module: "clientes",
        moduleName: "Clientes",
        action: "update",
        entity: "paquete-cliente",
        entityId: purchasedPackageId,
        description: message,
        details: { purchasedPackageId, drivePath: clean },
        req,
      });
      ok(res, message, {
        drivePath: clean,
        item: { purchasedPackageId, drivePath: clean },
      });
      return;
    }

    // ---- Movimiento propio: inversión, gasto o abono externo ----
    if (actionName === "movimiento") {
      const purchasedPackageId = Number(b.purchasedPackageId || 0);
      const kind = asKind(b.kind);
      const amount = asAmount(b.amount);
      if (!purchasedPackageId) {
        fail(res, 400, "Indica el paquete comprado", "El movimiento debe pertenecer a un paquete del cliente");
        return;
      }
      if (!kind) {
        fail(res, 400, "Tipo de movimiento inválido", String(b.kind ?? ""));
        return;
      }
      if (amount === null) {
        fail(res, 400, "El monto debe ser mayor a 0", "Escribe un monto válido");
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
      const description = norm(b.description);
      const userId = Number(b.userId || 0) || null;
      const r = await insertMovementSafe({
        purchasedPackageId,
        kind,
        amount,
        description,
        userId,
      });
      await logActivity({
        userId: me.sub,
        module: "clientes",
        moduleName: "Clientes",
        action: "create",
        entity: "movimiento",
        entityId: r.insertId,
        description: "Movimiento registrado exitosamente",
        details: { id: r.insertId, purchasedPackageId, kind, amount, description, userId },
        req,
      });
      created(res, "Movimiento registrado exitosamente", {
        id: r.insertId,
        kind,
        amount,
        item: { id: r.insertId, kind, amount, purchasedPackageId },
      });
      return;
    }

    // ---- Repartir pago: divide un monto entre colaboradores y empleados ----
    // Dos modos:
    //   * 'iguales'   → el total se parte en partes iguales (el último
    //                   absorbe los centavos sobrantes).
    //   * 'numeracion'→ cada destinatario recibe el monto que se escribió.
    // Cada parte se guarda como un movimiento aparte con kind 'pago' y el
    // usuario asignado, para poder ver a quién se le pagó y cuánto.
    if (actionName === "repartir-pago") {
      const purchasedPackageId = Number(b.purchasedPackageId || 0);
      if (!purchasedPackageId) {
        fail(res, 400, "Indica el paquete comprado", "El pago debe pertenecer a un paquete del cliente");
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

      // Destinatarios permitidos (colaborador o empleado, activos).
      const allowed = new Map<number, string>();
      for (const u of await loadRecipients()) {
        allowed.set(Number(u.id), String(u.name || "").trim());
      }
      if (!allowed.size) {
        fail(res, 400, "No hay colaboradores ni empleados activos", "Da de alta al menos uno para poder repartir");
        return;
      }

      const mode = norm(b.mode).toLowerCase();
      const description = norm(b.description);
      const round2 = (n: number) => Math.round(n * 100) / 100;
      const parts: { userId: number; amount: number }[] = [];

      if (mode === "iguales") {
        const total = asAmount(b.total);
        if (total === null) {
          fail(res, 400, "El monto debe ser mayor a 0", "Escribe el total a repartir");
          return;
        }
        const ids = (Array.isArray(b.userIds) ? b.userIds : [])
          .map((v) => Number(v))
          .filter((id) => id > 0);
        const unique = [...new Set(ids)].filter((id) => allowed.has(id));
        if (!unique.length) {
          fail(res, 400, "Selecciona a quién repartir", "Marca al menos un colaborador o empleado");
          return;
        }
        const base = round2(total / unique.length);
        let acumulado = 0;
        unique.forEach((id, i) => {
          const amount =
            i === unique.length - 1 ? round2(total - acumulado) : base;
          acumulado = round2(acumulado + amount);
          parts.push({ userId: id, amount });
        });
      } else if (mode === "numeracion") {
        const raw = Array.isArray(b.parts) ? b.parts : [];
        for (const p of raw) {
          const row = (p || {}) as Record<string, unknown>;
          const id = Number(row.userId || 0);
          if (!id || !allowed.has(id)) continue;
          const amount = asAmount(row.amount);
          if (amount === null) continue;
          parts.push({ userId: id, amount });
        }
        if (!parts.length) {
          fail(res, 400, "Escribe al menos un monto", "Cada destinatario necesita un monto mayor a 0");
          return;
        }
      } else {
        fail(res, 400, "Modo de reparto inválido", "Usa 'iguales' o 'numeracion'");
        return;
      }

      const totalPagado = round2(parts.reduce((s, p) => s + p.amount, 0));
      const payments: Row[] = [];
      for (const part of parts) {
        const who = allowed.get(part.userId) || "usuario";
        const r = await insertMovementSafe({
          purchasedPackageId,
          kind: "pago",
          amount: part.amount,
          description: description || `Pago a ${who}`,
          userId: part.userId,
        });
        payments.push({
          id: r.insertId,
          userId: part.userId,
          userName: who,
          amount: part.amount,
        });
      }
      await logActivity({
        userId: me.sub,
        module: "clientes",
        moduleName: "Clientes",
        action: "create",
        entity: "pago",
        entityId: purchasedPackageId,
        description: "Pago repartido exitosamente",
        details: { purchasedPackageId, mode, total: totalPagado, parts },
        req,
      });
      created(res, "Pago repartido exitosamente", {
        mode,
        total: totalPagado,
        count: payments.length,
        payments,
      });
      return;
    }

    fail(res, 400, "Acción no reconocida", String(b.action ?? ""));
  } catch (e) {
    console.error("[admin/package-progress]", e);
    fail(res, 500, "Hubo un error", "No se pudo completar la operación del paquete");
  }
});
