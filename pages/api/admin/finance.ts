import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { q, exec } from "../../../lib/db";

// ==================================================================
// FINANZAS DEL NEGOCIO -> /api/admin/finance
//
//   GET   { currency, totals, packages, months }
//     totals   ganancias (abonos cobrados), porCobrar (saldo), facturado,
//              disponible, ahorro, inversiones, gastos, abonoExterno
//     packages dinero de CADA paquete activo, con su cliente
//     months   últimos 6 meses: ganancias vs. gastos/inversiones/ahorro
//
//   POST  { purchasedPackageId, amount, description? }
//     Destina un monto al AHORRO del paquete (movimiento kind = 'ahorro').
//     El porcentaje se calcula en la app a partir del `disponible` que ya
//     devuelve este mismo GET, para no tener dos fórmulas distintas.
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
    res.status(405).json({ error: "Metodo no permitido" });
    return;
  }
  if (!(await requirePermission(req, res, "Finanzas", action))) return;

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
      for (const m of movements) {
        const id = Number(m.id_purchased_package || 0);
        const kind = String(m.kind || "");
        if (!id) continue;
        const bucket = byKind.get(id) ?? emptyByKind();
        const total = Number(m.total || 0);
        if (kind === "inversion") bucket.inversion += total;
        else if (kind === "ahorro") bucket.ahorro += total;
        else if (kind === "abono_externo") bucket.abonoExterno += total;
        else bucket.gasto += total;
        byKind.set(id, bucket);
      }

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
        const disponible = Math.max(0, round2(paid - gastado));
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

      res.status(200).json({
        currency,
        totals,
        packages: packagesOut,
        months: [...series.values()],
        movementsAvailable,
        moveKinds: MOVE_KINDS,
      });
      return;
    }

    // ================================ POST ===============================
    // Destina un monto al AHORRO de un paquete comprado.
    const b = (req.body || {}) as Record<string, unknown>;
    const purchasedPackageId = Number(b.purchasedPackageId || 0);
    if (!purchasedPackageId) {
      res.status(400).json({ error: "Indica el paquete comprado" });
      return;
    }
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
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
       VALUES (?, 'ahorro', ?, ?)`,
      [purchasedPackageId, round2(amount), description || null]
    );
    res.status(201).json({
      ok: true,
      id: r.insertId,
      kind: "ahorro",
      amount: round2(amount),
    });
  } catch (e) {
    console.error("[admin/finance]", e);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});
