import type { NextApiRequest, NextApiResponse } from "next";
import bcrypt from "bcryptjs";
import { withCors } from "../../../lib/cors";
import { q, exec } from "../../../lib/db";
import { requirePermission } from "../../../lib/permissions";
import { mapUser, UserRow } from "../../../lib/mappers";
import { ok, created, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";

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

  try {
    switch (req.method) {
      case "GET": {
        // EXCLUYE clientes: los usuarios con rol "Cliente"/"Client" viven en
        // el módulo Clientes (/api/admin/clients), no aquí.
        const rows = await q<UserRow & { role_name: string | null }>(
          `SELECT u.id, u.name, u.lastname, u.number, u.email, u.id_role, r.name AS role_name
             FROM users u
             LEFT JOIN roles r ON r.id = u.id_role
            WHERE u.active = 1
              AND u.id NOT IN (
                SELECT u2.id FROM users u2
                JOIN roles r2 ON r2.id = u2.id_role AND r2.active = 1
                 WHERE LOWER(r2.name) IN ('cliente', 'client')
              )
            ORDER BY u.id ASC`
        );
        res.status(200).json({
          users: rows.map((u) => ({
            ...mapUser(u, { id: u.id_role || 0, name: u.role_name }),
            roleId: u.id_role || null,
          })),
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
        const dup = await q(`SELECT id FROM users WHERE LOWER(email) = ? AND active = 1`, [email]);
        if (dup.length) {
          fail(res, 409, "Ya existe un usuario con ese email", email);
          return;
        }
        const hash = await bcrypt.hash(password, 10);
        const r = await exec(
          `INSERT INTO users (name, lastname, number, email, password, id_role)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [name, lastname, number, email, hash, id_role]
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
            const role = await q(`SELECT id FROM roles WHERE id = ? AND active = 1`, [id_role]);
            if (!role.length) {
              fail(res, 400, "El rol indicado no existe", `No hay un rol activo con id ${id_role}`);
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
        const r = await exec(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, [...params, id]);
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
        const r = await exec(`UPDATE users SET active = 0 WHERE id = ?`, [id]);
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
