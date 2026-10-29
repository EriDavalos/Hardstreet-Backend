import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { ok, created, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";
import { q, exec } from "../../../lib/db";
import { requestScope, scopeFilterOn } from "../../../lib/company-scope";

// ==================================================================
// FINANZAS · ESTIMACIÓN DE INVERSIÓN POR PAQUETE DEL CATÁLOGO
//
//   GET    /api/admin/finance-estimates
//          { packages: [ { id, name, subtitle, categoryName, currency,
//                          price, inversion, utilidad, margen,
//                          movements: [ { id, amount, description,
//                                         created } ] } ],
//            totals: { ingreso, inversion, utilidad },
//            estimatesAvailable }
//
//   POST   { idPackage, amount, description? }
//          Agrega UNA INVERSIÓN estimada del paquete del catálogo.
//
//   PUT    { movementId, amount?, description? }
//          Edita una inversión estimada.
//
//   DELETE ?id=N
//          Quita (baja lógica) una inversión estimada.
//
// ES DINERO FICTICIO DE PLANEACIÓN: cada paquete del CATÁLOGO (no por
// cliente) se DESGLOSA en varias INVERSIONES, una por una — igual que el
// administrador del paquete del cliente, pero sin dinero real.
//
//   * TODO lo que se captura es INVERSIÓN: es lo que se DESCUENTA del monto
//     del paquete.
//   * Ganancia estimada = precio del paquete − (suma de inversiones).
//   * NO escribe en purchased_packages_movements.
//   * NO entra en el dinero actual, el ahorro, los gastos ni el Dashboard:
//     solo se lee en la pestaña "Estimación" de Finanzas.
//
// Tabla: package_estimates (id_package → packages.id).
// Permiso: módulo "Finanzas" (ver para GET, editar para el resto).
// ==================================================================

type Row = Record<string, any>;

const norm = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const round2 = (n: number) => Math.round(n * 100) / 100;

function asAmount(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return round2(n);
}

/** Las inversiones estimadas de UN paquete (las más recientes primero). */
async function movementsOf(idPackage: number): Promise<Row[]> {
  return q<Row>(
    `SELECT id, amount, description,
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

/** Paquete + sus inversiones estimadas, con los totales ya calculados. */
function estimateOf(pkg: Row, movements: Row[]) {
  const price = Number(pkg.price || 0);
  // La INVERSIÓN es lo que se descuenta del monto del paquete.
  const inversion = movements.reduce((sum, m) => sum + Number(m.amount || 0), 0);
  const utilidad = round2(price - inversion);
  return {
    id: Number(pkg.id),
    name: String(pkg.name || ""),
    subtitle: String(pkg.subtitle || ""),
    categoryName: String(pkg.category_name || ""),
    currency: String(pkg.currency || "MXN"),
    price: round2(price),
    inversion: round2(inversion),
    utilidad,
    // % de lo que se cobra que se queda como ganancia (null si es gratis).
    margen: price > 0 ? round2((utilidad / price) * 100) : null,
    movements: movements.map((m) => ({
      id: Number(m.id),
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

      // Inversiones estimadas de todos los paquetes en UNA consulta.
      let estimatesAvailable = true;
      const byPackage = new Map<number, Row[]>();
      try {
        const rows = await q<Row>(
          `SELECT e.id, e.id_package, e.amount, e.description,
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
        // Sin la tabla todavía: se listan los paquetes con inversión en cero.
        estimatesAvailable = false;
      }

      const out = packages.map((p) =>
        estimateOf(p, byPackage.get(Number(p.id)) ?? [])
      );
      const totals = out.reduce(
        (acc, e) => ({
          ingreso: round2(acc.ingreso + e.price),
          inversion: round2(acc.inversion + e.inversion),
          utilidad: round2(acc.utilidad + e.utilidad),
        }),
        { ingreso: 0, inversion: 0, utilidad: 0 }
      );

      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({
        ok: true,
        packages: out,
        totals,
        estimatesAvailable,
      });
      return;
    }

    // ================================ DELETE =============================
    if (req.method === "DELETE") {
      const movementId = Number(req.query.id || 0);
      if (!movementId) {
        fail(res, 400, "Indica la inversión estimada", "Falta el id");
        return;
      }
      const rows = await q<Row>(
        `SELECT id, id_package FROM package_estimates
          WHERE id = ? AND id_company = ? LIMIT 1`,
        [movementId, companyId]
      );
      if (!rows.length) {
        fail(res, 404, "Inversión estimada no encontrada", `No hay un registro con id ${movementId}`);
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
        description: "Inversión estimada eliminada",
        details: { id: movementId },
        req,
      });
      ok(res, "Inversión estimada eliminada", { estimate, item: estimate });
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
      const amount = asAmount(body.amount);
      if (amount === null) {
        fail(res, 400, "La inversión debe ser mayor a 0", "Escribe un monto válido");
        return;
      }
      const description = norm(body.description);
      let r: { insertId?: number };
      try {
        r = await exec(
          `INSERT INTO package_estimates
             (id_package, amount, description, id_company)
           VALUES (?, ?, ?, ?)`,
          [idPackage, amount, description || null, companyId]
        );
      } catch (e) {
        console.error("[finance-estimates:create]", e);
        fail(
          res,
          409,
          "No se pudo guardar la inversión estimada",
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
        description: "Inversión estimada registrada",
        details: { idPackage, amount, description },
        req,
      });
      created(res, "Inversión estimada registrada", {
        estimate,
        item: { id: r.insertId, idPackage, amount, description },
      });
      return;
    }

    // ================================ PUT ================================
    // Edita una inversión estimada (monto o concepto).
    const movementId = Number(body.movementId || 0);
    if (!movementId) {
      fail(res, 400, "Indica la inversión estimada", "Falta el movimiento");
      return;
    }
    const rows = await q<Row>(
      `SELECT id, id_package, amount, description
         FROM package_estimates
        WHERE id = ? AND id_company = ? AND active = 1 LIMIT 1`,
      [movementId, companyId]
    );
    if (!rows.length) {
      fail(res, 404, "Inversión estimada no encontrada", `No hay un registro con id ${movementId}`);
      return;
    }
    const current = rows[0];
    const amount =
      body.amount === undefined || body.amount === null || body.amount === ""
        ? round2(Number(current.amount || 0))
        : asAmount(body.amount);
    if (amount === null) {
      fail(res, 400, "La inversión debe ser mayor a 0", "Escribe un monto válido");
      return;
    }
    const description =
      body.description === undefined
        ? String(current.description || "")
        : norm(body.description);
    await exec(
      `UPDATE package_estimates
          SET amount = ?, description = ?
        WHERE id = ? AND id_company = ?`,
      [amount, description || null, movementId, companyId]
    );
    const estimate = await loadEstimate(Number(current.id_package), companyId);
    await logActivity({
      userId: me.sub,
      module: "finance",
      moduleName: "Finanzas",
      action: "update",
      entity: "estimacion",
      entityId: movementId,
      description: "Inversión estimada actualizada",
      details: { id: movementId, amount, description },
      req,
    });
    ok(res, "Inversión estimada actualizada", { estimate, item: estimate });
  } catch (e) {
    console.error("[admin/finance-estimates]", e);
    fail(res, 500, "Hubo un error", "No se pudo leer o guardar la estimación");
  }
});
