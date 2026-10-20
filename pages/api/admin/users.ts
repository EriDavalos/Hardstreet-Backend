import type { NextApiRequest, NextApiResponse } from "next";
import bcrypt from "bcryptjs";
import { withCors } from "../../../lib/cors";
import { q, exec } from "../../../lib/db";
import {
  requirePermission,
  userIsAdmin,
  userIsSuperAdmin,
  userRoleId,
} from "../../../lib/permissions";
import { mapUser, UserRow } from "../../../lib/mappers";
import { ok, created, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";
import { readPaging, pageMeta } from "../../../lib/pagination";
import { requestScope, scopeFilterOn } from "../../../lib/company-scope";

// ==================================================================
// CRUD de usuarios (solo rol Admin)  ->  /api/admin/users
//   GET            lista usuarios con su rol
//   POST           crea usuario { name, lastname, number, email, password, id_role }
//   PUT/PATCH      actualiza { id, name?, lastname?, number?, email?, password?, id_role? }
//   DELETE         baja logica (?id=N) — active = 0
// ==================================================================

const norm = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Modelo del usuario tal como lo expone el listado (para `item`). */
async function userModel(id: number) {
  const rows = await q<UserRow & { role_name: string | null }>(
    `SELECT u.id, u.name, u.lastname, u.number, u.email, u.id_role, r.name AS role_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.id_role
      WHERE u.id = ? LIMIT 1`,
    [id]
  );
  if (!rows.length) return { id };
  const u = rows[0];
  return {
    ...mapUser(u, { id: u.id_role || 0, name: u.role_name }),
    roleId: u.id_role || null,
  };
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  // Permiso por acción: ver / crear / editar / eliminar el módulo "usuarios".
  // (El rol Admin pasa siempre; el resto depende de permissions_roles.)
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
  const me = await requirePermission(req, res, "usuarios", action);
  if (!me) return;

  // REGLA DEL ROL MÁS ALTO: la cuenta Admin no se toca ni se ve desde otros
  // roles. Solo un Admin (o el Superadministrador, que es el nivel más alto)
  // puede listarla, editarla o eliminarla.
  const requesterIsAdmin = await userIsAdmin(await userRoleId(me.sub));
  // El rol Superadmin es del sistema: solo el propio Superadministrador puede
  // asignarlo (a nadie se le "escapa" desde Usuarios).
  const requesterIsSuper = await userIsSuperAdmin(await userRoleId(me.sub));

  // Alcance por empresa: cada usuario pertenece a UNA empresa. El Superadmin
  // puede elegir con `X-Company-Id` o dejar que vea todas.
  const scope = await requestScope(req, me);
  const scopeSql = scopeFilterOn(scope, "u");
  const companyId = scope.writeCompanyId;

  /** ¿El rol [roleId] es el Superadministrador? */
  async function roleIsSuper(roleId: number | null): Promise<boolean> {
    if (!roleId) return false;
    const rows = await q<{ id: number }>(
      "SELECT id FROM roles WHERE id = ? AND LOWER(name) = 'superadmin' AND active = 1 LIMIT 1",
      [roleId]
    );
    return rows.length > 0;
  }

  /** ¿El usuario [id] es una cuenta con rol Admin? */
  async function targetIsAdmin(id: number): Promise<boolean> {
    return userIsAdmin(await userRoleId(id));
  }

  /** ¿El usuario [id] es el Superadministrador? */
  async function targetIsSuper(id: number): Promise<boolean> {
    return roleIsSuper(await userRoleId(id));
  }

  try {
    switch (req.method) {
      case "GET": {
        // EXCLUYE clientes: los usuarios con rol "Cliente"/"Client" viven en
        // el módulo Clientes (/api/admin/clients), no aquí.
        //
        // PAGINADO EN EL SERVIDOR: la app manda ?page=1&limit=30 y recibe SOLO
        // esa página + `total`/`pages`. El buscador (`q`) y el filtro por rol
        // (`role`) también se resuelven aquí, así el panel no se trae la tabla
        // completa para filtrar en memoria.
        const p = readPaging(req);
        const search = norm(req.query.q);
        const roleName = norm(req.query.role);

        // Condiciones comunes (sin el filtro de rol): alimentan los chips.
        const base: string[] = [
          "u.active = 1",
          `u.id NOT IN (
             SELECT u2.id FROM users u2
             JOIN roles r2 ON r2.id = u2.id_role AND r2.active = 1
              WHERE LOWER(r2.name) IN ('cliente', 'client')
           )`,
        ];
        const baseParams: unknown[] = [];
        base.push(scopeSql.sql);
        baseParams.push(...scopeSql.params);
        // Los Admin quedan OCULTOS para quien no sea Admin.
        if (!requesterIsAdmin) {
          base.push("(r.name IS NULL OR LOWER(r.name) <> 'admin')");
        }
        // El Superadministrador queda FUERA del listado salvo que lo pida él
        // mismo: los demás ni siquiera deben saber que la cuenta existe.
        if (!requesterIsSuper) {
          base.push("(r.name IS NULL OR LOWER(r.name) <> 'superadmin')");
        }
        if (search) {
          const like = `%${search}%`;
          base.push(
            "(u.name LIKE ? OR u.lastname LIKE ? OR u.email LIKE ? OR r.name LIKE ?)"
          );
          baseParams.push(like, like, like, like);
        }

        // El filtro elegido se suma DESPUÉS de los conteos de los chips.
        const where = [...base];
        const params = [...baseParams];
        if (roleName) {
          where.push("LOWER(r.name) = LOWER(?)");
          params.push(roleName);
        }
        const sqlWhere = where.join(" AND ");

        const countRows = await q<{ n: number }>(
          `SELECT COUNT(*) AS n FROM users u
             LEFT JOIN roles r ON r.id = u.id_role
            WHERE ${sqlWhere}`,
          params
        );
        const baseCount = await q<{ n: number }>(
          `SELECT COUNT(*) AS n FROM users u
             LEFT JOIN roles r ON r.id = u.id_role
            WHERE ${base.join(" AND ")}`,
          baseParams
        );
        const rows = await q<UserRow & { role_name: string | null }>(
          `SELECT u.id, u.name, u.lastname, u.number, u.email, u.id_role, r.name AS role_name
             FROM users u
             LEFT JOIN roles r ON r.id = u.id_role
            WHERE ${sqlWhere}
            ORDER BY u.id ASC
            LIMIT ${p.limit} OFFSET ${p.offset}`,
          params
        );
        // Conteo por rol para los chips del filtro (respeta el buscador).
        const facetRows = await q<{ name: string | null; n: number }>(
          `SELECT r.name AS name, COUNT(*) AS n
             FROM users u
             LEFT JOIN roles r ON r.id = u.id_role
            WHERE ${base.join(" AND ")}
            GROUP BY r.name
            ORDER BY r.name ASC`,
          baseParams
        );
        const roleCounts: Record<string, number> = {};
        for (const f of facetRows) {
          const key = (f.name || "").toString().trim();
          if (!key) continue;
          roleCounts[key] = Number(f.n || 0);
        }
        res.status(200).json({
          users: rows.map((u) => ({
            ...mapUser(u, { id: u.id_role || 0, name: u.role_name }),
            roleId: u.id_role || null,
          })),
          roleCounts,
          allTotal: Number(baseCount[0]?.n || 0),
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
        const id_role = Number(b.id_role || 0) || null;
        const number = norm(b.number);

        if (!name || !email || !password) {
          fail(
            res,
            400,
            "Nombre, email y contraseña son obligatorios",
            "Completa los tres campos para crear al usuario"
          );
          return;
        }
        if (id_role && !requesterIsSuper && (await roleIsSuper(id_role))) {
          fail(
            res,
            403,
            "Solo el Superadministrador asigna ese rol",
            "El rol Superadmin es del sistema"
          );
          return;
        }
        // Crear directamente una cuenta Admin también es exclusivo del Admin:
        // si no, cualquier rol podría saltarse la regla del rol más alto.
        if (!requesterIsAdmin && id_role) {
          const adminRole = await q<{ id: number }>(
            `SELECT id FROM roles WHERE id = ? AND LOWER(name) = 'admin' AND active = 1 LIMIT 1`,
            [id_role]
          );
          if (adminRole.length) {
            fail(
              res,
              403,
              "Solo un administrador puede crear otro administrador",
              "El rol Admin es el más alto y no se asigna desde otro rol"
            );
            return;
          }
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
          [name, lastname, number, email, hash, id_role, companyId]
        );
        const item = { id: r.insertId, name, lastname, number, email, roleId: id_role };
        await logActivity({
          userId: me.sub,
          module: "usuarios",
          moduleName: "Usuarios",
          action: "create",
          entity: "usuario",
          entityId: r.insertId,
          description: "Usuario creado exitosamente",
          details: item,
          req,
        });
        created(res, "Usuario creado exitosamente", { item });
        return;
      }

      case "PUT":
      case "PATCH": {
        const b = (req.body || {}) as Record<string, unknown>;
        const id = Number(b.id || 0);
        if (!id) {
          fail(res, 400, "Falta el id del usuario", "Indica qué usuario quieres modificar");
          return;
        }
        // Nadie edita una cuenta Admin salvo otro Admin (ni puede ascender a
        // nadie a Admin si no lo es).
        if (!requesterIsSuper && (await targetIsSuper(id))) {
          fail(
            res,
            403,
            "Solo el superadministrador puede modificar esta cuenta",
            "La cuenta Superadministrador administra todo el sistema"
          );
          return;
        }
        if (!requesterIsAdmin && (await targetIsAdmin(id))) {
          fail(
            res,
            403,
            "Solo un administrador puede modificar al administrador",
            "La cuenta Admin es el rol más alto del sistema"
          );
          return;
        }
        if (!requesterIsAdmin && b.id_role !== undefined) {
          const wanted = Number(b.id_role || 0);
          if (wanted && !requesterIsSuper && (await roleIsSuper(wanted))) {
            fail(
              res,
              403,
              "Solo el Superadministrador asigna ese rol",
              "El rol Superadmin es del sistema"
            );
            return;
          }
          if (wanted) {
            const adminRole = await q<{ id: number }>(
              `SELECT id FROM roles WHERE id = ? AND LOWER(name) = 'admin' AND active = 1 LIMIT 1`,
              [wanted]
            );
            if (adminRole.length) {
              fail(
                res,
                403,
                "Solo un administrador puede dar el rol Admin",
                "El rol Admin es el más alto y no se asigna desde otro rol"
              );
              return;
            }
          }
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
        if (b.id_role !== undefined) {
          const id_role = Number(b.id_role || 0) || null;
          if (id_role) {
            const role = await q(
              `SELECT id FROM roles WHERE id = ? AND active = 1
                AND (id_company = ? OR id_company IS NULL)`,
              [id_role, companyId]
            );
            if (!role.length) {
              fail(res, 400, "El rol indicado no existe", `No hay un rol activo con id ${id_role}`);
              return;
            }
            if (!requesterIsSuper && (await roleIsSuper(id_role))) {
              fail(
                res,
                403,
                "Solo el superadministrador puede asignar ese rol",
                "El rol Superadministrador solo lo otorga un Superadministrador"
              );
              return;
            }
          }
          fields.push(`id_role = ?`);
          params.push(id_role);
        }
        if (!fields.length) {
          fail(res, 400, "Nada que actualizar", "No enviaste ningún campo del usuario");
          return;
        }
        const r = await exec(
          `UPDATE users SET ${fields.join(", ")} WHERE id = ? AND ${scopeSql.sql}`,
          [...params, id, ...scopeSql.params]
        );
        if (!r.affectedRows) {
          fail(res, 404, "Usuario no encontrado", `No hay un usuario activo con id ${id}`);
          return;
        }
        const item = await userModel(id);
        await logActivity({
          userId: me.sub,
          module: "usuarios",
          moduleName: "Usuarios",
          action: "update",
          entity: "usuario",
          entityId: id,
          description: "Usuario actualizado exitosamente",
          details: item,
          req,
        });
        ok(res, "Usuario actualizado exitosamente", { item });
        return;
      }

      case "DELETE": {
        const id = Number(req.query.id || 0);
        if (!id) {
          fail(res, 400, "Falta el id del usuario", "Indica qué usuario quieres eliminar");
          return;
        }
        if (id === me.sub) {
          fail(res, 400, "No puedes eliminar tu propia cuenta", "Estás intentando borrar tu sesión actual");
          return;
        }
        if (!requesterIsSuper && (await targetIsSuper(id))) {
          fail(
            res,
            403,
            "Solo el superadministrador puede eliminar esta cuenta",
            "La cuenta Superadministrador administra todo el sistema"
          );
          return;
        }
        if (await targetIsAdmin(id)) {
          if (!requesterIsAdmin) {
            fail(
              res,
              403,
              "Solo un administrador puede eliminar al administrador",
              "La cuenta Admin es el rol más alto del sistema"
            );
            return;
          }
          // Ni siquiera un Admin puede quedarse sin ningún Admin activo.
          const admins = await q<{ n: number }>(
            `SELECT COUNT(*) AS n
               FROM users u
               JOIN roles r ON r.id = u.id_role AND r.active = 1
              WHERE u.active = 1 AND LOWER(r.name) = 'admin' AND ${scopeSql.sql}`,
            scopeSql.params
          );
          if (Number(admins[0]?.n || 0) <= 1) {
            fail(
              res,
              400,
              "No puedes eliminar al último administrador",
              "Crea o asigna otro Admin antes de borrar esta cuenta"
            );
            return;
          }
        }
        const r = await exec(
          `UPDATE users SET active = 0 WHERE id = ? AND ${scopeSql.sql}`,
          [id, ...scopeSql.params]
        );
        if (!r.affectedRows) {
          fail(res, 404, "Usuario no encontrado", `No hay un usuario activo con id ${id}`);
          return;
        }
        await logActivity({
          userId: me.sub,
          module: "usuarios",
          moduleName: "Usuarios",
          action: "delete",
          entity: "usuario",
          entityId: id,
          description: "Usuario eliminado exitosamente",
          details: { id },
          req,
        });
        ok(res, "Usuario eliminado exitosamente", { item: { id } });
        return;
      }

      default:
        fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
    }
  } catch (e) {
    console.error("[admin/users]", e);
    fail(res, 500, "Hubo un error", "No se pudo completar la operación del usuario");
  }
});
