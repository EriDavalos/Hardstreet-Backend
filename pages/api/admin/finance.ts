import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { ok, created, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";
import { q, exec } from "../../../lib/db";

// ==================================================================
// FINANZAS DEL NEGOCIO -> /api/admin/finance
//
//   GET   { currency, totals, packages, months, movements }
//     totals    ganancias (abonos cobrados), porCobrar (saldo), facturado,
//               disponible, ahorro, inversiones, gastos, abonoExterno
//     packages  dinero de CADA paquete activo, con su cliente
//     months    últimos 6 meses: ganancias vs. gastos/inversiones/ahorro
//     movements movimientos INDIVIDUALES (con paquete y cliente) para que el
//               módulo pueda desglosar cada fila de su tabla; los abonos
//               (payments) vienen con kind = 'abono'.
//
//   POST  { purchasedPackageId?, kind?, amount, description? }
//     Registra un movimiento de tipo gasto | inversion | ahorro |
//     abono_externo (por defecto 'ahorro'). El porcentaje se calcula en la
//     app a partir del `disponible` que ya devuelve este mismo GET, para no
//     tener dos fórmulas distintas.
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

/** Tipos de movimiento que participan en las cuentas. */
const MOVE_KINDS = ["gasto", "inversion", "ahorro", "abono_externo"] as const;

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

  try {
    // ================================ GET ================================
    if (req.method === "GET") {
      // Paquetes activos con su cliente (subselect: un paquete puede tener
      // más de un vínculo y no queremos filas duplicadas).
      const packages = await q<Row>(
        `SELECT pp.id, pp.name, pp.price, pp.paid, pp.currency,
                (SELECT TRIM(CONCAT(u2.name, ' ', COALESCE(u2.lastname, '')))
                   FROM users_packages up2
                   JOIN users u2 ON u2.id = up2.id_user
                  WHERE up2.id_purchased_package = pp.id
                    AND up2.active = 1 AND u2.active = 1
                  ORDER BY up2.id LIMIT 1) AS client_name
           FROM purchased_packages pp
          WHERE pp.active = 1
          ORDER BY pp.id DESC`
      );

      // Movimientos activos: total por paquete y por tipo.
      let movements: Row[] = [];
      let movementsAvailable = true;
      try {
        movements = await q<Row>(
          `SELECT id_purchased_package, kind, COALESCE(SUM(amount), 0) AS total
             FROM purchased_packages_movements
            WHERE active = 1
            GROUP BY id_purchased_package, kind`
        );
      } catch {
        // Migración de movimientos pendiente: el resto del módulo sigue.
        movementsAvailable = false;
      }

      const emptyByKind = () => ({
        gasto: 0,
        inversion: 0,
        ahorro: 0,
        abonoExterno: 0,
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
        else if (kind === "abono_externo") bucket.abonoExterno += total;
        else bucket.gasto += total;
        if (id) byKind.set(id, bucket);
      }

      let generalOut = {
        gastos: 0,
        inversiones: 0,
        salidas: 0,
        ahorro: 0,
        abonoExterno: 0,
        neto: 0,
      };

      const totals = {
        facturado: 0,
        ganancias: 0,
        porCobrar: 0,
        disponible: 0,
        ahorro: 0,
        inversiones: 0,
        gastos: 0,
        abonoExterno: 0,
      };

      const packagesOut = packages.map((p) => {
        const id = Number(p.id);
        const price = Number(p.price || 0);
        const paid = Number(p.paid || 0);
        const k = byKind.get(id) ?? emptyByKind();
        // Gastado = gasto + inversión (la inversión también es dinero que
        // sale), igual que en el administrador del paquete.
        const gastado = k.gasto + k.inversion;
        // DISPONIBLE = abonado - gastado - ahorro + abono externo.
        // El ahorro se APARTA (sale del disponible) y el abono externo es
        // dinero que entra por fuera del paquete (se suma). Misma fórmula
        // que /api/admin/package-progress.
        const disponible = Math.max(
          0,
          round2(paid - gastado - k.ahorro + k.abonoExterno)
        );
        const porCobrar = Math.max(0, round2(price - paid));

        totals.facturado += price;
        totals.ganancias += paid;
        totals.porCobrar += porCobrar;
        totals.disponible += disponible;
        totals.ahorro += k.ahorro;
        totals.inversiones += k.inversion;
        totals.gastos += k.gasto;
        totals.abonoExterno += k.abonoExterno;

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
          ahorro: round2(k.ahorro),
          disponible,
        };
      });

      // ---- Movimientos GENERALES del negocio ----
      // Gastado = gasto + inversión; el ahorro se aparta y el abono externo
      // entra por fuera, igual que en un paquete.
      const generalGastado = general.gasto + general.inversion;
      const generalNeto =
        general.abonoExterno - generalGastado - general.ahorro;
      generalOut = {
        gastos: round2(general.gasto),
        inversiones: round2(general.inversion),
        salidas: round2(generalGastado),
        ahorro: round2(general.ahorro),
        abonoExterno: round2(general.abonoExterno),
        neto: round2(generalNeto),
      };
      // El negocio entero: lo que suman los paquetes MENOS lo que se gastó,
      // se apartó o entró por fuera del paquete.
      totals.gastos += general.gasto;
      totals.inversiones += general.inversion;
      totals.ahorro += general.ahorro;
      totals.abonoExterno += general.abonoExterno;
      totals.disponible = Math.max(
        0,
        round2(totals.disponible - generalGastado - general.ahorro + general.abonoExterno)
      );

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
            WHERE active = 1 AND created >= ?
            GROUP BY ym`,
          [from]
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
            WHERE active = 1 AND created >= ?
            GROUP BY ym, kind`,
          [from]
        );
        for (const r of rows) {
          const bucket = series.get(String(r.ym || ""));
          if (!bucket) continue;
          const kind = String(r.kind || "");
          const total = round2(Number(r.total || 0));
          if (kind === "inversion") bucket.inversiones = total;
          else if (kind === "ahorro") bucket.ahorro = total;
          else if (kind === "abono_externo") bucket.abonoExterno = total;
          else bucket.gastos = total;
        }
      } catch {
        // Ídem: la gráfica se queda solo con las ganancias.
      }

      const currency =
        packagesOut.find((p) => p.currency)?.currency ||
        String(packages[0]?.currency || "MXN");

      // ---- Movimientos INDIVIDUALES (desglose de la tabla) ----
      // La tabla expande cada fila: los paquetes para ver su resumen y cada
      // tipo de movimiento para ver sus registros uno por uno.
      const nameById = new Map<number, { name: string; clientName: string }>();
      for (const p of packagesOut) {
        nameById.set(p.id, { name: p.name, clientName: p.clientName });
      }
      let movementRows: Row[] = [];
      if (movementsAvailable) {
        try {
          // LEFT JOIN: los movimientos GENERALES (sin paquete) también
          // salen en el desglose, con packageId = 0.
          const rows = await q<Row>(
            `SELECT m.id, m.id_purchased_package AS package_id, m.kind,
                    m.amount, m.description,
                    DATE_FORMAT(m.created, '%Y-%m-%dT%H:%i:%s') AS created
               FROM purchased_packages_movements m
               LEFT JOIN purchased_packages pp ON pp.id = m.id_purchased_package
              WHERE m.active = 1 AND (pp.id IS NULL OR pp.active = 1)
              ORDER BY m.created DESC, m.id DESC
              LIMIT 400`
          );
          const pays = await q<Row>(
            `SELECT p.id, p.id_purchased_package AS package_id,
                    'abono' AS kind, p.amount, p.description,
                    DATE_FORMAT(p.created, '%Y-%m-%dT%H:%i:%s') AS created
               FROM purchased_packages_payments p
               JOIN purchased_packages pp ON pp.id = p.id_purchased_package
              WHERE p.active = 1 AND pp.active = 1
              ORDER BY p.created DESC, p.id DESC
              LIMIT 400`
          );
          movementRows = [...pays, ...rows].sort((a, b) =>
            String(b.created).localeCompare(String(a.created))
          );
        } catch {
          movementRows = [];
        }
      }

      res.status(200).json({
        currency,
        totals,
        // Dinero registrado SIN paquete (gastos/inversiones/ahorro del
        // negocio). La tabla de la app lo muestra como grupo "General".
        general: generalOut,
        packages: packagesOut,
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
          };
        }),
        movementsAvailable,
        moveKinds: MOVE_KINDS,
      });
      return;
    }

    // ================================ POST ===============================
    // Registra un movimiento (gasto | inversion | ahorro | abono_externo).
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
        `SELECT id FROM purchased_packages WHERE id = ? AND active = 1`,
        [purchasedPackageId]
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
           (id_purchased_package, kind, amount, description)
         VALUES (?, ?, ?, ?)`,
        [purchasedPackageId || null, kind, round2(amount), description || null]
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
