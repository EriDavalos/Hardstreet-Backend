import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { ok, created, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";
import { q, exec } from "../../../lib/db";
import { requestScope, scopeFilter, scopeFilterOn } from "../../../lib/company-scope";

// ==================================================================
// FINANZAS DEL NEGOCIO -> /api/admin/finance
//
//   GET   { currency, totals, packages, months, movements, payees, payments }
//     totals    ganancias (abonos cobrados), porCobrar (saldo), facturado,
//               disponible (DINERO ACTUAL), ahorro, inversiones, gastos,
//               abonoExterno y pagos
//     packages  dinero de CADA paquete activo, con su cliente. Los paquetes
//               GRATIS (precio 0) se omiten salvo que tengan algún abono,
//               gasto, inversión, ahorro, abono externo o pago.
//     payees    pagos agrupados por colaborador/empleado (total histórico)
//     payments  cada pago individual, con su destinatario y su paquete
//
//     DINERO ACTUAL = abonos + abono externo - gastos e inversión de los
//                     PAQUETES - ahorro apartado - pagos. Los pagos a
//                     colaboradores/empleados SÍ salen, y los movimientos
//                     GENERALES (gasto/inversión) se pagan con el AHORRO:
//                     bajan lo apartado, no el dinero actual.
//     months    últimos 6 meses: ganancias vs. gastos/inversiones/ahorro
//     movements movimientos INDIVIDUALES (con paquete y cliente) para que el
//               módulo pueda desglosar cada fila de su tabla; los abonos
//               (payments) vienen con kind = 'abono'.
//
//   POST  { purchasedPackageId?, kind?, amount, description? }
//     Registra un movimiento de tipo gasto | inversion | ahorro |
//     abono_externo | retiro_ahorro (por defecto 'ahorro'). El porcentaje se
//     calcula en la app a partir del `disponible` que ya devuelve este mismo
//     GET, para no tener dos fórmulas distintas.
//
//     `retiro_ahorro` = SACAR dinero del ahorro: baja SOLO lo apartado y no
//     toca el dinero actual (el dinero ya había salido del negocio).
//
// La pestaña "Estimación" NO vive aquí: es planeación por paquete del
// CATÁLOGO, en /api/admin/finance-estimates.
//
//     SIN `purchasedPackageId` el movimiento es GENERAL (del negocio, sin
//     paquete): el módulo Finanzas ya no obliga a elegir un paquete. Esos
//     movimientos afectan a los TOTALES del negocio (gastos, inversiones,
//     ahorro, abono externo y disponible) y se agrupan en `general`.
//
// Fuentes (las mismas del administrador del paquete):
//   purchased_packages.paid            -> abonos cobrados
//   purchased_packages_payments        -> abonos (histórico)
//   purchased_packages_movements       -> gasto | inversion | ahorro |
//                                        abono_externo
// Permiso: módulo "Finanzas" (ver / editar). El rol Admin siempre pasa, así
// que el módulo funciona aunque la migración del módulo aún no se aplique.
// ==================================================================

/**
 * Tipos de movimiento que participan en las cuentas.
 *
 * `retiro_ahorro` = SACAR dinero del ahorro. Baja SOLO lo apartado: no
 * devuelve dinero al negocio, así que no toca el dinero actual.
 */
const MOVE_KINDS = [
  "gasto",
  "inversion",
  "ahorro",
  "abono_externo",
  "retiro_ahorro",
] as const;

type Row = Record<string, any>;

const norm = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Etiqueta corta del mes en español (para los ejes de la gráfica). */
const MONTH_LABELS = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
];

/** Los últimos [count] meses (claves `YYYY-MM` y etiqueta corta). */
function lastMonths(count: number): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const now = new Date();
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    out.push({ key, label: MONTH_LABELS[d.getMonth()] });
  }
  return out;
}

/** Primer día del mes más antiguo de la ventana (para el WHERE). */
function windowStart(count: number): string {
  const d = new Date();
  const from = new Date(d.getFullYear(), d.getMonth() - (count - 1), 1);
  return `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-01`;
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  const action = req.method === "GET" ? "read" : "update";
  if (req.method !== "GET" && req.method !== "POST") {
    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
    return;
  }
  const me = await requirePermission(req, res, "Finanzas", action);
  if (!me) return;

  // Alcance por empresa: cada estudio lleva sus propias cuentas.
  const scope = await requestScope(req, me);
  const pkgScope = scopeFilterOn(scope, "pp");
  const movScope = scopeFilter(scope);
  const payScope = scopeFilter(scope);
  // Las consultas de HISTORIAL unen `purchased_packages_movements` (alias m)
  // y `purchased_packages_payments` (alias p) con `purchased_packages` (pp):
  // las tres tablas tienen id_company, así que el filtro va CUALIFICADO o
  // MySQL lo rechaza por ambiguo (y el historial salía vacío).
  const movJoinScope = scopeFilterOn(scope, "m");
  const payJoinScope = scopeFilterOn(scope, "p");
  const companyId = scope.writeCompanyId;

  try {
    // ================================ GET ================================
    if (req.method === "GET") {
      // Paquetes activos CON UN CLIENTE ACTIVO (subselect: un paquete puede
      // tener más de un vínculo y no queremos filas duplicadas).
      //
      // Un cliente dado de baja (users.active = 0) NO cuenta: sus paquetes
      // desaparecen del módulo, así no suman precios (facturado) ni aparecen
      // en el historial. Lo mismo si el vínculo (users_packages) está
      // desactivado. Así, un cliente en activo 0 no infla los totales.
      const packages = await q<Row>(
        `SELECT pp.id, pp.name, pp.price, pp.paid, pp.currency,
                (SELECT TRIM(CONCAT(u2.name, ' ', COALESCE(u2.lastname, '')))
                   FROM users_packages up2
                   JOIN users u2 ON u2.id = up2.id_user
                  WHERE up2.id_purchased_package = pp.id
                    AND up2.active = 1 AND u2.active = 1
                  ORDER BY up2.id LIMIT 1) AS client_name
           FROM purchased_packages pp
          WHERE pp.active = 1 AND ${pkgScope.sql}
            AND EXISTS (SELECT 1
                          FROM users_packages upx
                          JOIN users ux ON ux.id = upx.id_user
                         WHERE upx.id_purchased_package = pp.id
                           AND upx.active = 1 AND ux.active = 1)
          ORDER BY pp.id DESC`,
        pkgScope.params
      );

      // Movimientos activos: total por paquete y por tipo.
      let movements: Row[] = [];
      let movementsAvailable = true;
      try {
        movements = await q<Row>(
          `SELECT id_purchased_package, kind, COALESCE(SUM(amount), 0) AS total
             FROM purchased_packages_movements
            WHERE active = 1 AND ${movScope.sql}
            GROUP BY id_purchased_package, kind`,
          movScope.params
        );
      } catch {
        // Migración de movimientos pendiente: el resto del módulo sigue.
        movementsAvailable = false;
      }

      const emptyByKind = () => ({
        gasto: 0,
        inversion: 0,
        ahorro: 0,
        // Retiros del ahorro: bajan lo apartado, no el dinero actual.
        retiros: 0,
        abonoExterno: 0,
        // Los PAGOS a colaboradores/empleados salen del dinero: se
        // descuentan del paquete y del dinero actual (y se pueden desglosar
        // por persona en `payees` / `payments`).
        pagos: 0,
      });
      type ByKind = ReturnType<typeof emptyByKind>;

      const byKind = new Map<number, ByKind>();
      // Movimientos GENERALES (sin paquete): son del negocio entero.
      const general = emptyByKind();
      for (const m of movements) {
        const id = Number(m.id_purchased_package || 0);
        const kind = String(m.kind || "");
        const total = Number(m.total || 0);
        const bucket = id ? byKind.get(id) ?? emptyByKind() : general;
        if (kind === "inversion") bucket.inversion += total;
        else if (kind === "ahorro") bucket.ahorro += total;
        else if (kind === "retiro_ahorro") bucket.retiros += total;
        else if (kind === "abono_externo") bucket.abonoExterno += total;
        else if (kind === "pago") bucket.pagos += total;
        else bucket.gasto += total;
        if (id) byKind.set(id, bucket);
      }

      let generalOut = {
        gastos: 0,
        inversiones: 0,
        salidas: 0,
        ahorro: 0,
        ahorroApartado: 0,
        retiros: 0,
        abonoExterno: 0,
        pagos: 0,
        neto: 0,
      };

      const totals = {
        facturado: 0,
        ganancias: 0,
        porCobrar: 0,
        disponible: 0,
        // Ahorro que QUEDA apartado (lo apartado menos los retiros).
        ahorro: 0,
        // Retiros del ahorro: no son una salida del dinero actual.
        retiros: 0,
        inversiones: 0,
        gastos: 0,
        abonoExterno: 0,
        // Pagos repartidos a colaboradores/empleados: SÍ son una salida.
        pagos: 0,
        // Ganancia ESTIMADA: abonado + abono externo − inversión − ahorro
        // (sin descontar gastos ni pagos).
        gananciaEstimada: 0,
        // Ganancia REAL / DINERO ACTUAL: la estimada MENOS los gastos y los
        // pagos. Coincide con el `disponible` del negocio.
        gananciaReal: 0,
      };

      const packagesOut = packages.map((p) => {
        const id = Number(p.id);
        const price = Number(p.price || 0);
        const paid = Number(p.paid || 0);
        const k = byKind.get(id) ?? emptyByKind();
        // Gastado = gasto + inversión (la inversión también es dinero que
        // sale); los pagos se restan aparte, para poder verlos por persona.
        const gastado = k.gasto + k.inversion;
        // DINERO ACTUAL = abonado + abono externo - gastos - inversión -
        // ahorro - pagos. Los PAGOS a colaboradores/empleados SÍ salen del
        // dinero (antes se trataban como un "gasto invisible").
        //
        // Ojo: aquí se resta lo APARTADO COMPLETO (`k.ahorro`); los retiros
        // NO devuelven dinero al negocio, así que no suman al disponible.
        const disponible = round2(
          paid + k.abonoExterno - gastado - k.ahorro - k.pagos
        );
        // Ahorro que QUEDA en el paquete: lo apartado menos lo retirado.
        const ahorroNeto = Math.max(0, round2(k.ahorro - k.retiros));
        const porCobrar = Math.max(0, round2(price - paid));

        return {
          id,
          name: String(p.name || ""),
          clientName: String(p.client_name || ""),
          currency: String(p.currency || "MXN"),
          price,
          paid,
          balance: porCobrar,
          gastos: round2(k.gasto),
          inversiones: round2(k.inversion),
          abonoExterno: round2(k.abonoExterno),
          // Ahorro que queda y lo apartado en bruto (para explicar la resta).
          ahorro: ahorroNeto,
          ahorroApartado: round2(k.ahorro),
          retiros: round2(k.retiros),
          pagos: round2(k.pagos),
          // Ganancia estimada/real del paquete (mismo criterio que el total).
          gananciaEstimada: round2(
            paid - k.inversion - k.ahorro + k.abonoExterno
          ),
          gananciaReal: disponible,
          disponible,
        };
      });

      // PAQUETES GRATIS: no salen en Finanzas salvo que tengan ALGO
      // registrado (un abono, un gasto, una inversión, ahorro, abono externo
      // o un pago). Un paquete de precio 0 sin movimientos solo llenaba la
      // tabla de ceros.
      const packagesVisible = packagesOut.filter(
        (p) =>
          p.price > 0 ||
          p.paid > 0 ||
          p.gastos > 0 ||
          p.inversiones > 0 ||
          p.ahorro > 0 ||
          // Un paquete cuyo ahorro se retiró del todo sigue teniendo historia.
          p.ahorroApartado > 0 ||
          p.retiros > 0 ||
          p.abonoExterno > 0 ||
          p.pagos > 0
      );
      for (const p of packagesVisible) {
        totals.facturado += p.price;
        totals.ganancias += p.paid;
        totals.porCobrar += p.balance;
        // El ahorro que se suma a los totales es el APARTADO (bruto): los
        // retiros se restan al final, del pozo, para no inflar el disponible.
        totals.ahorro += p.ahorroApartado;
        totals.retiros += p.retiros;
        totals.inversiones += p.inversiones;
        totals.gastos += p.gastos;
        totals.abonoExterno += p.abonoExterno;
        totals.pagos += p.pagos;
      }

      // ---- Movimientos GENERALES del negocio ----
      // Gastado = gasto + inversión; el ahorro se aparta y el abono externo
      // entra por fuera, igual que en un paquete. Los pagos también salen.
      const generalGastado = general.gasto + general.inversion;
      const generalNeto =
        general.abonoExterno - generalGastado - general.ahorro - general.pagos;
      generalOut = {
        gastos: round2(general.gasto),
        inversiones: round2(general.inversion),
        salidas: round2(generalGastado),
        // Lo que QUEDA del ahorro del negocio tras sus retiros.
        ahorro: round2(Math.max(0, general.ahorro - general.retiros)),
        ahorroApartado: round2(general.ahorro),
        retiros: round2(general.retiros),
        abonoExterno: round2(general.abonoExterno),
        pagos: round2(general.pagos),
        neto: round2(generalNeto),
      };
      // PAQUETES vs. GENERAL. Un gasto o una inversión de un PAQUETE ya baja
      // el dinero de ESE paquete (y no toca el ahorro). Los movimientos
      // GENERALES se pagan con el AHORRO: bajan lo apartado y NO bajan el
      // dinero actual del negocio.
      const pkgGastos = totals.gastos;
      const pkgInversiones = totals.inversiones;
      // Lo apartado en el ahorro (paquetes + general): eso SÍ sale del dinero
      // actual, porque está guardado.
      const apartado = totals.ahorro + general.ahorro;
      // El ahorro no puede quedar en negativo: si los movimientos generales
      // superan lo apartado, lo que falte se descuenta del dinero actual.
      const pozo = apartado - generalGastado;
      const sinCubrir = Math.max(0, -pozo);
      // RETIROS: sacar dinero del ahorro (paquetes + general). Bajan SOLO lo
      // apartado; el disponible no se mueve (el dinero ya había salido del
      // negocio al apartarlo, y un retiro tampoco lo devuelve).
      const retiros = totals.retiros + general.retiros;

      // El negocio entero suma paquetes + movimientos generales.
      totals.gastos = pkgGastos + general.gasto;
      totals.inversiones = pkgInversiones + general.inversion;
      totals.ahorro = Math.max(0, round2(pozo - retiros));
      totals.retiros = round2(retiros);
      totals.abonoExterno += general.abonoExterno;
      totals.pagos += general.pagos;
      // DINERO ACTUAL (lo que se tiene hoy): abonado + abono externo - gastos
      // e inversión de los PAQUETES - lo apartado en el ahorro - pagos - lo
      // que el ahorro no alcanzó a cubrir.
      totals.gananciaEstimada = round2(
        totals.ganancias +
          totals.abonoExterno -
          pkgInversiones -
          apartado
      );
      totals.gananciaReal = round2(
        totals.gananciaEstimada - pkgGastos - totals.pagos - sinCubrir
      );
      totals.disponible = totals.gananciaReal;

      for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
        totals[key] = round2(totals[key]);
      }

      // ---- Serie de los últimos 6 meses ----
      const months = lastMonths(6);
      const series = new Map<string, Row>();
      for (const m of months) {
        series.set(m.key, {
          month: m.key,
          label: m.label,
          ganancias: 0,
          gastos: 0,
          inversiones: 0,
          ahorro: 0,
          abonoExterno: 0,
        });
      }
      const from = windowStart(6);
      try {
        const rows = await q<Row>(
          `SELECT DATE_FORMAT(created, '%Y-%m') AS ym,
                  COALESCE(SUM(amount), 0) AS total
             FROM purchased_packages_payments
            WHERE active = 1 AND ${payScope.sql} AND created >= ?
            GROUP BY ym`,
          [...payScope.params, from]
        );
        for (const r of rows) {
          const bucket = series.get(String(r.ym || ""));
          if (bucket) bucket.ganancias = round2(Number(r.total || 0));
        }
      } catch {
        // Sin abonos no hay serie: se queda en ceros.
      }
      try {
        const rows = await q<Row>(
          `SELECT DATE_FORMAT(created, '%Y-%m') AS ym, kind,
                  COALESCE(SUM(amount), 0) AS total
             FROM purchased_packages_movements
            WHERE active = 1 AND ${movScope.sql} AND created >= ?
            GROUP BY ym, kind`,
          [...movScope.params, from]
        );
        for (const r of rows) {
          const bucket = series.get(String(r.ym || ""));
          if (!bucket) continue;
          const kind = String(r.kind || "");
          const total = round2(Number(r.total || 0));
          if (kind === "inversion") bucket.inversiones = total;
          else if (kind === "ahorro") bucket.ahorro = total;
          else if (kind === "abono_externo") bucket.abonoExterno = total;
          // Los pagos NO son salida: no entran en las barras de gastos. Los
          // RETIROS del ahorro tampoco: bajan lo apartado, no el dinero.
          else if (kind === "pago" || kind === "retiro_ahorro") continue;
          else bucket.gastos = total;
        }
      } catch {
        // Ídem: la gráfica se queda solo con las ganancias.
      }

      const currency =
        packagesVisible.find((p) => p.currency)?.currency ||
        String(packages[0]?.currency || "MXN");

      // ---- Movimientos INDIVIDUALES (desglose de la tabla) ----
      // La tabla expande cada fila: los paquetes para ver su resumen y cada
      // tipo de movimiento para ver sus registros uno por uno.
      const nameById = new Map<number, { name: string; clientName: string }>();
      for (const p of packagesVisible) {
        nameById.set(p.id, { name: p.name, clientName: p.clientName });
      }
      let movementRows: Row[] = [];
      if (movementsAvailable) {
        // El destinatario del pago (colaborador/empleado) es opcional: si la
        // columna `id_user` todavía no existe, se vuelve a consultar sin el
        // JOIN en vez de quedarse sin historial.
        const movementsQuery = (withUser: boolean) =>
          `SELECT m.id, m.id_purchased_package AS package_id, m.kind,
                  m.amount, m.description,
                  DATE_FORMAT(m.created, '%Y-%m-%dT%H:%i:%s') AS created,${
                    withUser
                      ? " m.id_user AS user_id, CONCAT_WS(' ', u.name, u.lastname) AS user_name"
                      : " NULL AS user_id, NULL AS user_name"
                  }
             FROM purchased_packages_movements m
             LEFT JOIN purchased_packages pp ON pp.id = m.id_purchased_package${
               withUser ? " LEFT JOIN users u ON u.id = m.id_user" : ""
             }
            WHERE m.active = 1 AND ${movJoinScope.sql}
              AND (pp.id IS NULL OR pp.active = 1)
            ORDER BY m.created DESC, m.id DESC
            LIMIT 400`;
        try {
          let rows: Row[];
          try {
            rows = await q<Row>(movementsQuery(true), movJoinScope.params);
          } catch {
            rows = await q<Row>(movementsQuery(false), movJoinScope.params);
          }
          const pays = await q<Row>(
            `SELECT p.id, p.id_purchased_package AS package_id,
                    'abono' AS kind, p.amount, p.description,
                    DATE_FORMAT(p.created, '%Y-%m-%dT%H:%i:%s') AS created,
                    NULL AS user_id, NULL AS user_name
               FROM purchased_packages_payments p
               JOIN purchased_packages pp ON pp.id = p.id_purchased_package
              WHERE p.active = 1 AND pp.active = 1 AND ${payJoinScope.sql}
              ORDER BY p.created DESC, p.id DESC
              LIMIT 400`,
            payJoinScope.params
          );
          movementRows = [...pays, ...rows].sort((a, b) =>
            String(b.created).localeCompare(String(a.created))
          );
        } catch {
          movementRows = [];
        }
        // Solo paquetes VIGENTES (con cliente activo) o movimientos
        // generales: así un cliente dado de baja tampoco sale en el historial.
        movementRows = movementRows.filter((m) => {
          const pid = Number(m.package_id || 0);
          return pid === 0 || nameById.has(pid);
        });
      }

      // ---- PAGOS A COLABORADORES Y EMPLEADOS ----
      // Se listan TODOS los pagos repartidos (kind = 'pago'), con su
      // destinatario, su rol y el paquete al que se cargaron. `payees` los
      // agrupa por PERSONA para la pestaña "Pagos".
      let paymentRows: Row[] = [];
      const paymentsQuery = (withUser: boolean) =>
        `SELECT m.id, ${withUser ? "m.id_user" : "NULL"} AS user_id,
                ${withUser ? "CONCAT_WS(' ', u.name, u.lastname)" : "NULL"} AS user_name,
                ${withUser ? "COALESCE(r.name, '')" : "''"} AS role_name,
                m.id_purchased_package AS package_id,
                COALESCE(pp.name, '') AS package_name,
                m.amount, m.description,
                DATE_FORMAT(m.created, '%Y-%m-%dT%H:%i:%s') AS created
           FROM purchased_packages_movements m${
             withUser
               ? " LEFT JOIN users u ON u.id = m.id_user LEFT JOIN roles r ON r.id = u.id_role"
               : ""
           }
           LEFT JOIN purchased_packages pp ON pp.id = m.id_purchased_package
          WHERE m.active = 1 AND m.kind = 'pago' AND ${movJoinScope.sql}
          ORDER BY m.created DESC, m.id DESC`;
      try {
        try {
          paymentRows = await q<Row>(paymentsQuery(true), movJoinScope.params);
        } catch {
          paymentRows = await q<Row>(paymentsQuery(false), movJoinScope.params);
        }
      } catch {
        paymentRows = [];
      }

      const payeeMap = new Map<
        number,
        {
          userId: number;
          name: string;
          roleName: string;
          total: number;
          count: number;
          packages: Set<number>;
          lastPaid: string;
        }
      >();
      for (const p of paymentRows) {
        const uid = Number(p.user_id || 0);
        const key = uid > 0 ? uid : -1;
        const name = String(p.user_name || "").trim() || "Sin destinatario";
        const prev = payeeMap.get(key);
        const amount = Number(p.amount || 0);
        if (prev) {
          prev.total += amount;
          prev.count += 1;
          prev.packages.add(Number(p.package_id || 0));
          if (String(p.created || "") > prev.lastPaid) {
            prev.lastPaid = String(p.created || "");
          }
        } else {
          payeeMap.set(key, {
            userId: uid,
            name,
            roleName: String(p.role_name || "").trim(),
            total: amount,
            count: 1,
            packages: new Set([Number(p.package_id || 0)]),
            lastPaid: String(p.created || ""),
          });
        }
      }
      const payees = [...payeeMap.values()]
        .map((p) => ({
          userId: p.userId,
          name: p.name,
          roleName: p.roleName,
          total: round2(p.total),
          count: p.count,
          packageCount: p.packages.size,
          lastPaid: p.lastPaid,
        }))
        .sort((a, b) => b.total - a.total);

      res.status(200).json({
        currency,
        totals,
        // Dinero registrado SIN paquete (gastos/inversiones/ahorro del
        // negocio). La pestaña "Por paquete" lo muestra como "General".
        general: generalOut,
        packages: packagesVisible,
        months: [...series.values()],
        movements: movementRows.map((m) => {
          const meta = nameById.get(Number(m.package_id)) || {
            name: "",
            clientName: "",
          };
          return {
            id: Number(m.id),
            packageId: Number(m.package_id || 0),
            packageName: meta.name,
            clientName: meta.clientName,
            kind: String(m.kind || "gasto"),
            amount: round2(Number(m.amount || 0)),
            description: String(m.description || ""),
            created: m.created || "",
            // Quién recibió el pago (solo movimientos con destinatario).
            userId: Number(m.user_id || 0),
            userName: String(m.user_name || "").trim(),
          };
        }),
        // Pagos a colaboradores/empleados, agrupados por PERSONA (pestaña
        // "Pagos"): total histórico, cuántos pagos y en cuántos paquetes.
        payees,
        // Cada pago individual (con su paquete y su fecha), para desglosar a
        // cada persona.
        payments: paymentRows.map((p) => {
          const pid = Number(p.package_id || 0);
          const meta = nameById.get(pid) || {
            name: String(p.package_name || ""),
            clientName: "",
          };
          return {
            id: Number(p.id),
            userId: Number(p.user_id || 0),
            userName: String(p.user_name || "").trim(),
            roleName: String(p.role_name || ""),
            packageId: pid,
            packageName: meta.name,
            clientName: meta.clientName,
            amount: round2(Number(p.amount || 0)),
            description: String(p.description || ""),
            created: p.created || "",
          };
        }),
        movementsAvailable,
        moveKinds: MOVE_KINDS,
      });
      return;
    }

    // ================================ POST ===============================
    // Registra un movimiento (gasto | inversion | ahorro | abono_externo |
    // retiro_ahorro).
    // Sin `kind` se asume AHORRO: es el caso que ya usaba el módulo.
    // Sin `purchasedPackageId` el movimiento es GENERAL (del negocio).
    const b = (req.body || {}) as Record<string, unknown>;
    const purchasedPackageId = Number(b.purchasedPackageId || 0);
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      fail(res, 400, "El monto debe ser mayor a 0", "Escribe un monto válido");
      return;
    }
    const kindRaw = norm(b.kind).toLowerCase().replace(/-/g, "_");
    const kind = (MOVE_KINDS as readonly string[]).includes(kindRaw)
      ? kindRaw
      : "ahorro";
    // Con paquete: se valida que exista. Sin paquete: movimiento general.
    if (purchasedPackageId) {
      const exists = await q(
        `SELECT id FROM purchased_packages
          WHERE id = ? AND active = 1 AND id_company = ?`,
        [purchasedPackageId, companyId]
      );
      if (!exists.length) {
        fail(res, 404, "Paquete comprado no encontrado", `No hay un paquete con id ${purchasedPackageId}`);
        return;
      }
    }
    const description = norm(b.description);
    let r: { insertId?: number };
    try {
      r = await exec(
        `INSERT INTO purchased_packages_movements
           (id_purchased_package, kind, amount, description, id_company)
         VALUES (?, ?, ?, ?, ?)`,
        [
          purchasedPackageId || null,
          kind,
          round2(amount),
          description || null,
          companyId,
        ]
      );
    } catch (e) {
      // La columna sigue siendo NOT NULL: falta la migración que permite los
      // movimientos GENERALES (del negocio, sin paquete).
      if (!purchasedPackageId) {
        fail(
          res,
          409,
          "No se pudo registrar el movimiento",
          "Falta aplicar la migración 2026-10-15 (movimientos generales sin paquete)"
        );
        return;
      }
      throw e;
    }
    const item = {
      id: r.insertId,
      kind,
      amount: round2(amount),
      description,
      purchasedPackageId: purchasedPackageId || null,
      general: !purchasedPackageId,
    };
    await logActivity({
      userId: me.sub,
      module: "finance",
      moduleName: "Finanzas",
      action: "create",
      entity: "movimiento",
      entityId: r.insertId,
      description: "Movimiento registrado exitosamente",
      details: item,
      req,
    });
    created(res, "Movimiento registrado exitosamente", { ...item, item });
  } catch (e) {
    console.error("[admin/finance]", e);
    fail(res, 500, "Hubo un error", "No se pudo registrar el movimiento de finanzas");
  }
});
