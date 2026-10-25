import type { NextApiRequest, NextApiResponse } from "next";
import bcrypt from "bcryptjs";
import { withCors } from "../../../lib/cors";
import { CLIENT_ROLE } from "../../../lib/admin-auth";
import { requirePermission } from "../../../lib/permissions";
import { q, exec } from "../../../lib/db";
import { mapUser, UserRow } from "../../../lib/mappers";
import { ok, created, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";
import { readPaging, pageMeta } from "../../../lib/pagination";
import { requestScope, scopeFilter, scopeFilterOn } from "../../../lib/company-scope";

// ==================================================================
// Clientes (solo rol Admin)  ->  /api/admin/clients
// Usuarios con rol fijo "Cliente" (no se asigna: siempre es cliente).
//   GET            lista clientes (con conteo de paquetes)
//   POST           crea cliente { name, lastname, number, email, password }
//   PUT/PATCH      actualiza { id, name?, lastname?, number?, email?, password? }
//   DELETE         baja logica (?id=N)
//   PUT/POST con action=assign-package / remove-package:
//          body { userId, packageId } asigna o quita un purchased_package
// ==================================================================

/**
 * Id del rol Cliente DE LA EMPRESA (cada empresa tiene sus propios roles).
 * Si la empresa todavía no tiene el suyo se usa el primero que exista, para
 * no dejar el módulo sin funcionar tras aplicar la migración.
 */
async function clientRoleId(companyId: number): Promise<number | null> {
  const rows = await q<{ id: number }>(
    `SELECT id FROM roles WHERE LOWER(name) IN ('cliente', 'client') AND active = 1
      ORDER BY (id_company = ?) DESC, id ASC LIMIT 1`,
    [companyId]
  );
  return rows[0]?.id ?? null;
}

const norm = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Modelo del cliente tal como lo expone el listado (para `item`). */
async function clientModel(id: number) {
  const rows = await q<UserRow & { role_name: string | null }>(
    `SELECT u.id, u.name, u.lastname, u.number, u.email, u.id_role, r.name AS role_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.id_role
      WHERE u.id = ? LIMIT 1`,
    [id]
  );
  if (!rows.length) return { id };
  const u = rows[0];
  return mapUser(u, { id: u.id_role || 0, name: u.role_name });
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  // Permiso por acción sobre el módulo "clientes" (Admin pasa siempre).
  const ACTIONS: Record<string, "read" | "create" | "update" | "delete"> = {
    GET: "read",
    POST: "create",
    PUT: "update",
    PATCH: "update",
    DELETE: "delete",
  };
  const action = ACTIONS[req.method || ""];
  if (!action) {
    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
    return;
  }
  const me = await requirePermission(req, res, "clientes", action);
  if (!me) return;

  // Alcance por empresa: el directorio de clientes es de UNA empresa.
  const scope = await requestScope(req, me);
  // `scopeSql` (alias `u`) es para las consultas con `FROM users u`; los
  // UPDATE de una sola tabla usan `scopeRow`, porque `u.id_company` ahí es un
  // error de MySQL (500 al editar o borrar un cliente).
  const scopeSql = scopeFilterOn(scope, "u");
  const scopeRow = scopeFilter(scope);
  const companyId = scope.writeCompanyId;

  const roleId = await clientRoleId(companyId);
  if (!roleId) {
    fail(
      res,
      500,
      "Hubo un error",
      "No existe el rol 'Cliente' en la base de datos"
    );
    return;
  }

  try {
    switch (req.method) {
      case "GET": {
        // PAGINADO EN EL SERVIDOR: ?page=1&limit=30 + buscador (`q`) y filtro
        // por paquetes (`packages` = con | sin). La app recibe solo la página
        // y el total, no el directorio entero.
        const p = readPaging(req);
        const search = norm(req.query.q);
        const pkgFilter = norm(req.query.packages).toLowerCase();

        // Cuenta los paquetes ACTIVOS del cliente (misma regla que la app).
        const pkgs =
          "(SELECT COUNT(*) FROM users_packages up" +
          " JOIN purchased_packages pp ON pp.id = up.id_purchased_package AND pp.active = 1" +
          " WHERE up.id_user = u.id AND up.active = 1)";

        const base: string[] = ["u.active = 1", "u.id_role = ?", scopeSql.sql];
        const baseParams: unknown[] = [roleId, ...scopeSql.params];
        if (search) {
          const like = `%${search}%`;
          base.push(
            "(u.name LIKE ? OR u.lastname LIKE ? OR u.email LIKE ? OR u.number LIKE ?)"
          );
          baseParams.push(like, like, like, like);
        }

        const where = [...base];
        const params = [...baseParams];
        if (pkgFilter === "con") where.push(`${pkgs} > 0`);
        if (pkgFilter === "sin") where.push(`${pkgs} = 0`);
        const sqlWhere = where.join(" AND ");
        const baseWhere = base.join(" AND ");

        const countRows = await q<{ n: number }>(
          `SELECT COUNT(*) AS n FROM users u WHERE ${sqlWhere}`,
          params
        );
        // Conteos para los chips + paquetes asignados (stat del módulo).
        const assignedScope = scopeFilterOn(scope, "u2");
        const facetRows = await q<{ con: number; total: number; assigned: number }>(
          `SELECT
              SUM(CASE WHEN ${pkgs} > 0 THEN 1 ELSE 0 END) AS con,
              COUNT(*) AS total,
              (SELECT COUNT(*) FROM users_packages up
                 JOIN purchased_packages pp ON pp.id = up.id_purchased_package AND pp.active = 1
                 JOIN users u2 ON u2.id = up.id_user AND u2.active = 1 AND u2.id_role = ?
                WHERE up.active = 1 AND ${assignedScope.sql}) AS assigned
             FROM users u
            WHERE ${baseWhere}`,
          [roleId, ...assignedScope.params, ...baseParams]
        );
        const rows = await q<UserRow & { role_name: string | null; packages_count: number }>(
          `SELECT u.id, u.name, u.lastname, u.number, u.email, u.id_role, r.name AS role_name,
                  ${pkgs} AS packages_count
             FROM users u
             LEFT JOIN roles r ON r.id = u.id_role
            WHERE ${sqlWhere}
            ORDER BY u.id ASC
            LIMIT ${p.limit} OFFSET ${p.offset}`,
          params
        );
        const facet = facetRows[0];
        const withPkgs = Number(facet?.con || 0);
        const allBase = Number(facet?.total || 0);
        res.status(200).json({
          clients: rows.map((u) => ({
            ...mapUser(u, { id: u.id_role || 0, name: u.role_name }),
            packagesCount: Number(u.packages_count || 0),
          })),
          pkgCounts: { with: withPkgs, without: allBase - withPkgs, all: allBase },
          assignedPackages: Number(facet?.assigned || 0),
          ...pageMeta(countRows[0]?.n, p),
        });
        return;
      }

      case "POST": {
        const b = (req.body || {}) as Record<string, unknown>;
        const name = norm(b.name);
        const lastname = norm(b.lastname);
        const email = norm(b.email).toLowerCase();
        const password = typeof b.password === "string" ? b.password : "";
        const number = norm(b.number);
        if (!name || !email || !password) {
          fail(
            res,
            400,
            "Nombre, email y contraseña son obligatorios",
            "Completa los tres campos para crear al cliente"
          );
          return;
        }
        const dup = await q(`SELECT id FROM users WHERE LOWER(email) = ? AND active = 1`, [email]);
        if (dup.length) {
          fail(res, 409, "Ya existe un usuario con ese email", email);
          return;
        }
        const hash = await bcrypt.hash(password, 10);
        const r = await exec(
          `INSERT INTO users (name, lastname, number, email, password, id_role, id_company)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [name, lastname, number, email, hash, roleId, companyId]
        );
        const item = { id: r.insertId, name, lastname, number, email };
        await logActivity({
          userId: me.sub,
          module: "clientes",
          moduleName: "Clientes",
          action: "create",
          entity: "cliente",
          entityId: r.insertId,
          description: "Cliente creado exitosamente",
          details: item,
          req,
        });
        created(res, "Cliente creado exitosamente", { item });
        return;
      }

      case "PUT":
      case "PATCH": {
        const b = (req.body || {}) as Record<string, unknown>;
        const id = Number(b.id || 0);
        if (!id) {
          fail(res, 400, "Falta el id del cliente", "Indica qué cliente quieres modificar");
          return;
        }
        // Solo clientes: evita editar admins desde este modulo
        const isClient = await q(
          `SELECT id FROM users WHERE id = ? AND id_role = ? AND ${scopeRow.sql} AND active = 1`,
          [id, roleId, ...scopeRow.params]
        );
        if (!isClient.length) {
          fail(res, 404, "Cliente no encontrado", `No hay un cliente activo con id ${id}`);
          return;
        }
        const fields: string[] = [];
        const params: unknown[] = [];
        for (const key of ["name", "lastname", "number"] as const) {
          if (b[key] !== undefined) {
            fields.push(`${key} = ?`);
            params.push(norm(b[key]));
          }
        }
        if (b.email !== undefined) {
          const email = norm(b.email).toLowerCase();
          if (!email) {
            fail(res, 400, "El email no puede estar vacío", "Escribe un correo válido");
            return;
          }
          const dup = await q(
            `SELECT id FROM users WHERE LOWER(email) = ? AND active = 1 AND id <> ?`,
            [email, id]
          );
          if (dup.length) {
            fail(res, 409, "Ya existe un usuario con ese email", email);
            return;
          }
          fields.push(`email = ?`);
          params.push(email);
        }
        if (typeof b.password === "string" && b.password.length > 0) {
          fields.push(`password = ?`);
          params.push(await bcrypt.hash(b.password, 10));
        }
        if (!fields.length) {
          fail(res, 400, "Nada que actualizar", "No enviaste ningún campo del cliente");
          return;
        }
        await exec(`UPDATE users SET ${fields.join(", ")} WHERE id = ? AND ${scopeRow.sql}`, [
          ...params,
          id,
          ...scopeRow.params,
        ]);
        const item = await clientModel(id);
        await logActivity({
          userId: me.sub,
          module: "clientes",
          moduleName: "Clientes",
          action: "update",
          entity: "cliente",
          entityId: id,
          description: "Cliente actualizado exitosamente",
          details: item,
          req,
        });
        ok(res, "Cliente actualizado exitosamente", { item });
        return;
      }

      case "DELETE": {
        const id = Number(req.query.id || 0);
        if (!id) {
          fail(res, 400, "Falta el id del cliente", "Indica qué cliente quieres eliminar");
          return;
        }
        const r = await exec(
          `UPDATE users SET active = 0 WHERE id = ? AND id_role = ? AND ${scopeRow.sql}`,
          [id, roleId, ...scopeRow.params]
        );
        if (!r.affectedRows) {
          fail(res, 404, "Cliente no encontrado", `No hay un cliente activo con id ${id}`);
          return;
        }
        await logActivity({
          userId: me.sub,
          module: "clientes",
          moduleName: "Clientes",
          action: "delete",
          entity: "cliente",
          entityId: id,
          description: "Cliente eliminado exitosamente",
          details: { id },
          req,
        });
        ok(res, "Cliente eliminado exitosamente", { item: { id } });
        return;
      }

      default:
        fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
    }
  } catch (e) {
    console.error("[admin/clients]", e);
    fail(res, 500, "Hubo un error", "No se pudo completar la operación del cliente");
  }
});
