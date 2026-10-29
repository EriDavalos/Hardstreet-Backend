import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { ok, created, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";
import { q, exec } from "../../../lib/db";
import { requestScope, scopeFilterOn } from "../../../lib/company-scope";

// ==================================================================
// FINANZAS · ESTIMACIÓN DE COSTOS POR PAQUETE DEL CATÁLOGO
//
//   GET    /api/admin/finance-estimates
//          { packages: [ { id, name, subtitle, categoryName, currency,
//                          price, inversion, gasto, costo, utilidad, margen,
//                          movements: [ { id, kind, amount, description,
//                                         created } ] } ],
//            totals: { ingreso, inversion, gasto, costo, utilidad },
//            estimatesAvailable, moveKinds }
//
//   POST   { idPackage, kind, amount, description? }
//          Registra un movimiento ESTIMADO del paquete del catálogo.
//
//   PUT    { movementId, kind?, amount?, description? }
//          Edita un movimiento estimado.
//
//   DELETE ?id=N
//          Quita (baja lógica) un movimiento estimado.
//
// ES DINERO FICTICIO DE PLANEACIÓN: se estima, para CADA paquete del
// CATÁLOGO (no por cliente), cuánto se va a invertir y gastar, con sus
// movimientos uno por uno — igual que el administrador del paquete del
// cliente, pero sin dinero real.
//
//   * NO escribe en purchased_packages_movements.
//   * NO entra en el dinero actual, el ahorro, los gastos ni el Dashboard:
//     solo se lee en la pestaña "Estimación" de Finanzas.
//
// Tabla: package_estimates (id_package → packages.id).
// Permiso: módulo "Finanzas" (ver para GET, editar para el resto).
// ==================================================================

/** Tipos de un movimiento ESTIMADO (los dos lados del costo). */
const ESTIMATE_KINDS = ["inversion", "gasto"] as const;
type EstimateKind = (typeof ESTIMATE_KINDS)[number];

type Row = Record<string, any>;

const norm = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const round2 = (n: number) => Math.round(n * 100) / 100;

function asKind(raw: unknown): EstimateKind | null {
  const k = norm(raw).toLowerCase().replace(/-/g, "_");
  return (ESTIMATE_KINDS as readonly string[]).includes(k)
    ? (k as EstimateKind)
    : null;
}

function asAmount(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return round2(n);
}

/** Los movimientos estimados de UN paquete (los más recientes primero). */
async function movementsOf(idPackage: number): Promise<Row[]> {
  return q<Row>(
    `SELECT id, kind, amount, description,
            DATE_FORMAT(created, '%Y-%m-%dT%H:%i:%s') AS created
       FROM package_estimates
      WHERE id_package = ? AND active = 1
      ORDER BY created DESC, id DESC`,
    [idPackage]
  );
}

/** Un paquete del catálogo (con el nombre de su categoría). */
async function catalogPackage(
  idPackage: number,
  companyId: number
): Promise<Row | null> {
  const rows = await q<Row>(
    `SELECT p.id, p.name, p.subtitle, p.price, p.currency,
            COALESCE(pc.name, '') AS category_name
       FROM packages p
       LEFT JOIN packages_categories pc ON pc.id = p.id_package_category
      WHERE p.id = ? AND p.active = 1 AND p.id_company = ?
      LIMIT 1`,
    [idPackage, companyId]
  );
  return rows[0] ?? null;
}

/** Paquete + sus movimientos estimados, con los totales ya calculados. */
function estimateOf(pkg: Row, movements: Row[]) {
  const price = Number(pkg.price || 0);
  const inversion = movements
    .filter((m) => m.kind === "inversion")
    .reduce((sum, m) => sum + Number(m.amount || 0), 0);
  const gasto = movements
    .filter((m) => m.kind === "gasto")
    .reduce((sum, m) => sum + Number(m.amount || 0), 0);
  const costo = round2(inversion + gasto);
  const utilidad = round2(price - costo);
  return {
    id: Number(pkg.id),
    name: String(pkg.name || ""),
    subtitle: String(pkg.subtitle || ""),
    categoryName: String(pkg.category_name || ""),
    currency: String(pkg.currency || "MXN"),
    price: round2(price),
    inversion: round2(inversion),
    gasto: round2(gasto),
    costo,
    utilidad,
    // % de lo que se cobra que se queda como ganancia (null si es gratis).
    margen: price > 0 ? round2((utilidad / price) * 100) : null,
    movements: movements.map((m) => ({
      id: Number(m.id),
      kind: String(m.kind || "gasto"),
      amount: round2(Number(m.amount || 0)),
      description: String(m.description || ""),
      created: m.created || "",
    })),
  };
}

/** Estimación completa de un paquete (para devolverla tras cada cambio). */
async function loadEstimate(idPackage: number, companyId: number) {
  const pkg = await catalogPackage(idPackage, companyId);
  if (!pkg) return null;
  return estimateOf(pkg, await movementsOf(idPackage));
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  const action = req.method === "GET" ? "read" : "update";
  if (!["GET", "POST", "PUT", "DELETE"].includes(req.method || "")) {
    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
    return;
  }
  const me = await requirePermission(req, res, "Finanzas", action);
  if (!me) return;

  // Alcance por empresa: cada estudio estima sus propios paquetes.
  const scope = await requestScope(req, me);
  const companyId = scope.writeCompanyId;
  const pkgScope = scopeFilterOn(scope, "p");
  const estScope = scopeFilterOn(scope, "e");

  try {
    // ================================ GET ================================
    if (req.method === "GET") {
      // TODOS los paquetes del catálogo de la empresa (activos).
      const packages = await q<Row>(
        `SELECT p.id, p.name, p.subtitle, p.price, p.currency,
                COALESCE(pc.name, '') AS category_name
           FROM packages p
           LEFT JOIN packages_categories pc ON pc.id = p.id_package_category
          WHERE p.active = 1 AND ${pkgScope.sql}
          ORDER BY pc.name ASC, p.name ASC`,
        pkgScope.params
      );

      // Movimientos estimados de todos los paquetes en UNA consulta.
      let estimatesAvailable = true;
      const byPackage = new Map<number, Row[]>();
      try {
        const rows = await q<Row>(
          `SELECT e.id, e.id_package, e.kind, e.amount, e.description,
                  DATE_FORMAT(e.created, '%Y-%m-%dT%H:%i:%s') AS created
             FROM package_estimates e
            WHERE e.active = 1 AND ${estScope.sql}
            ORDER BY e.created DESC, e.id DESC`,
          estScope.params
        );
        for (const r of rows) {
          const key = Number(r.id_package || 0);
          const list = byPackage.get(key) ?? [];
          list.push(r);
          byPackage.set(key, list);
        }
      } catch {
        // Sin la tabla todavía: se listan los paquetes con costo en cero.
        estimatesAvailable = false;
      }

      const out = packages.map((p) => estimateOf(p, byPackage.get(Number(p.id)) ?? []));
      const totals = out.reduce(
        (acc, e) => ({
          ingreso: round2(acc.ingreso + e.price),
          inversion: round2(acc.inversion + e.inversion),
          gasto: round2(acc.gasto + e.gasto),
          costo: round2(acc.costo + e.costo),
          utilidad: round2(acc.utilidad + e.utilidad),
        }),
        { ingreso: 0, inversion: 0, gasto: 0, costo: 0, utilidad: 0 }
      );

      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({
        ok: true,
        packages: out,
        totals,
        estimatesAvailable,
        moveKinds: ESTIMATE_KINDS,
      });
      return;
    }

    // ================================ DELETE =============================
    if (req.method === "DELETE") {
      const movementId = Number(req.query.id || 0);
      if (!movementId) {
        fail(res, 400, "Indica el movimiento estimado", "Falta el id");
        return;
      }
      const rows = await q<Row>(
        `SELECT id, id_package FROM package_estimates
          WHERE id = ? AND id_company = ? LIMIT 1`,
        [movementId, companyId]
      );
      if (!rows.length) {
        fail(res, 404, "Movimiento estimado no encontrado", `No hay un registro con id ${movementId}`);
        return;
      }
      await exec(`UPDATE package_estimates SET active = 0 WHERE id = ?`, [movementId]);
      const estimate = await loadEstimate(Number(rows[0].id_package), companyId);
      await logActivity({
        userId: me.sub,
        module: "finance",
        moduleName: "Finanzas",
        action: "delete",
        entity: "estimacion",
        entityId: movementId,
        description: "Movimiento estimado eliminado",
        details: { id: movementId },
        req,
      });
      ok(res, "Movimiento estimado eliminado", { estimate, item: estimate });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;

    // ================================ POST ===============================
    if (req.method === "POST") {
      const idPackage = Number(body.idPackage || 0);
      if (!idPackage) {
        fail(res, 400, "Indica el paquete", "La estimación es de un paquete del catálogo");
        return;
      }
      const pkg = await catalogPackage(idPackage, companyId);
      if (!pkg) {
        fail(res, 404, "Paquete no encontrado", `No hay un paquete activo con id ${idPackage}`);
        return;
      }
      const kind = asKind(body.kind) ?? "inversion";
      const amount = asAmount(body.amount);
      if (amount === null) {
        fail(res, 400, "El monto debe ser mayor a 0", "Escribe un monto válido");
        return;
      }
      const description = norm(body.description);
      let r: { insertId?: number };
      try {
        r = await exec(
          `INSERT INTO package_estimates
             (id_package, kind, amount, description, id_company)
           VALUES (?, ?, ?, ?, ?)`,
          [idPackage, kind, amount, description || null, companyId]
        );
      } catch (e) {
        console.error("[finance-estimates:create]", e);
        fail(
          res,
          409,
          "No se pudo guardar el movimiento estimado",
          "Falta crear la tabla package_estimates (ver el SQL del módulo Finanzas)"
        );
        return;
      }
      const estimate = await loadEstimate(idPackage, companyId);
      await logActivity({
        userId: me.sub,
        module: "finance",
        moduleName: "Finanzas",
        action: "create",
        entity: "estimacion",
        entityId: r.insertId,
        description: "Movimiento estimado registrado",
        details: { idPackage, kind, amount, description },
        req,
      });
      created(res, "Movimiento estimado registrado", {
        estimate,
        item: { id: r.insertId, idPackage, kind, amount, description },
      });
      return;
    }

    // ================================ PUT ================================
    // Edita un movimiento estimado (monto, tipo o concepto).
    const movementId = Number(body.movementId || 0);
    if (!movementId) {
      fail(res, 400, "Indica el movimiento estimado", "Falta el movimiento");
      return;
    }
    const rows = await q<Row>(
      `SELECT id, id_package, kind, amount, description
         FROM package_estimates
        WHERE id = ? AND id_company = ? AND active = 1 LIMIT 1`,
      [movementId, companyId]
    );
    if (!rows.length) {
      fail(res, 404, "Movimiento estimado no encontrado", `No hay un registro con id ${movementId}`);
      return;
    }
    const current = rows[0];
    const kind = asKind(body.kind) ?? (String(current.kind) as EstimateKind);
    const amount =
      body.amount === undefined || body.amount === null || body.amount === ""
        ? round2(Number(current.amount || 0))
        : asAmount(body.amount);
    if (amount === null) {
      fail(res, 400, "El monto debe ser mayor a 0", "Escribe un monto válido");
      return;
    }
    const description =
      body.description === undefined
        ? String(current.description || "")
        : norm(body.description);
    await exec(
      `UPDATE package_estimates
          SET kind = ?, amount = ?, description = ?
        WHERE id = ? AND id_company = ?`,
      [kind, amount, description || null, movementId, companyId]
    );
    const estimate = await loadEstimate(Number(current.id_package), companyId);
    await logActivity({
      userId: me.sub,
      module: "finance",
      moduleName: "Finanzas",
      action: "update",
      entity: "estimacion",
      entityId: movementId,
      description: "Movimiento estimado actualizado",
      details: { id: movementId, kind, amount, description },
      req,
    });
    ok(res, "Movimiento estimado actualizado", { estimate, item: estimate });
  } catch (e) {
    console.error("[admin/finance-estimates]", e);
    fail(res, 500, "Hubo un error", "No se pudo leer o guardar la estimación");
  }
});
