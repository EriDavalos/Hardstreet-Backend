import type { NextApiRequest, NextApiResponse } from "next";
import bcrypt from "bcryptjs";
import { withCors } from "../../../lib/cors";
import { q, exec } from "../../../lib/db";
import { requirePermission } from "../../../lib/permissions";
import { mapUser, UserRow } from "../../../lib/mappers";

// ==================================================================
// CRUD de usuarios (solo rol Admin)  ->  /api/admin/users
//   GET            lista usuarios con su rol
//   POST           crea usuario { name, lastname, number, email, password, id_role }
//   PUT/PATCH      actualiza { id, name?, lastname?, number?, email?, password?, id_role? }
//   DELETE         baja logica (?id=N) — active = 0
// ==================================================================

const norm = (v: unknown) => (typeof v === "string" ? v.trim() : "");

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
    res.status(405).json({ error: "Metodo no permitido" });
    return;
  }
  const me = await requirePermission(req, res, "usuarios", action);
  if (!me) return;

  try {
    switch (req.method) {
      case "GET": {
        const rows = await q<UserRow & { role_name: string | null }>(
          `SELECT u.id, u.name, u.lastname, u.number, u.email, u.id_role, r.name AS role_name
             FROM users u
             LEFT JOIN roles r ON r.id = u.id_role
            WHERE u.active = 1
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
          res.status(400).json({ error: "Nombre, email y contrasena son obligatorios" });
          return;
        }
        const dup = await q(`SELECT id FROM users WHERE LOWER(email) = ? AND active = 1`, [email]);
        if (dup.length) {
          res.status(409).json({ error: "Ya existe un usuario con ese email" });
          return;
        }
        const hash = await bcrypt.hash(password, 10);
        const r = await exec(
          `INSERT INTO users (name, lastname, number, email, password, id_role)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [name, lastname, number, email, hash, id_role]
        );
        res.status(201).json({ ok: true, id: r.insertId });
        return;
      }

      case "PUT":
      case "PATCH": {
        const b = (req.body || {}) as Record<string, unknown>;
        const id = Number(b.id || 0);
        if (!id) {
          res.status(400).json({ error: "Falta el id del usuario" });
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
            res.status(400).json({ error: "El email no puede estar vacio" });
            return;
          }
          const dup = await q(
            `SELECT id FROM users WHERE LOWER(email) = ? AND active = 1 AND id <> ?`,
            [email, id]
          );
          if (dup.length) {
            res.status(409).json({ error: "Ya existe un usuario con ese email" });
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
              res.status(400).json({ error: "El rol indicado no existe" });
              return;
            }
          }
          fields.push(`id_role = ?`);
          params.push(id_role);
        }
        if (!fields.length) {
          res.status(400).json({ error: "Nada que actualizar" });
          return;
        }
        const r = await exec(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, [...params, id]);
        if (!r.affectedRows) {
          res.status(404).json({ error: "Usuario no encontrado" });
          return;
        }
        res.status(200).json({ ok: true });
        return;
      }

      case "DELETE": {
        const id = Number(req.query.id || 0);
        if (!id) {
          res.status(400).json({ error: "Falta el id del usuario" });
          return;
        }
        if (id === me.sub) {
          res.status(400).json({ error: "No puedes eliminar tu propia cuenta" });
          return;
        }
        const r = await exec(`UPDATE users SET active = 0 WHERE id = ?`, [id]);
        if (!r.affectedRows) {
          res.status(404).json({ error: "Usuario no encontrado" });
          return;
        }
        res.status(200).json({ ok: true });
        return;
      }

      default:
        res.status(405).json({ error: "Metodo no permitido" });
    }
  } catch (e) {
    console.error("[admin/users]", e);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});
