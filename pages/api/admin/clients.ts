import type { NextApiRequest, NextApiResponse } from "next";
import bcrypt from "bcryptjs";
import { withCors } from "../../../lib/cors";
import { requireAdmin, CLIENT_ROLE } from "../../../lib/admin-auth";
import { q, exec } from "../../../lib/db";
import { mapUser, UserRow } from "../../../lib/mappers";

// ==================================================================
// Clientes (solo rol Admin)  ->  /api/admin/clients
// Usuarios con rol fijo "Client" (no se asigna: siempre es cliente).
//   GET            lista clientes (con conteo de paquetes)
//   POST           crea cliente { name, lastname, number, email, password }
//   PUT/PATCH      actualiza { id, name?, lastname?, number?, email?, password? }
//   DELETE         baja logica (?id=N)
//   PUT/POST con action=assign-package / remove-package:
//          body { userId, packageId } asigna o quita un purchased_package
// ==================================================================

async function clientRoleId(): Promise<number | null> {
  const rows = await q<{ id: number }>(
    `SELECT id FROM roles WHERE LOWER(name) = ? AND active = 1 LIMIT 1`,
    [CLIENT_ROLE.toLowerCase()]
  );
  return rows[0]?.id ?? null;
}

const norm = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (!(await requireAdmin(req, res))) return;

  const roleId = await clientRoleId();
  if (!roleId) {
    res.status(500).json({ error: "No existe el rol 'Client' en la base de datos" });
    return;
  }

  try {
    switch (req.method) {
      case "GET": {
        const rows = await q<UserRow & { role_name: string | null; packages_count: number }>(
          `SELECT u.id, u.name, u.lastname, u.number, u.email, u.id_role, r.name AS role_name,
                  (SELECT COUNT(*) FROM users_packages up
                    JOIN purchased_packages pp ON pp.id = up.id_purchased_package AND pp.active = 1
                   WHERE up.id_user = u.id AND up.active = 1) AS packages_count
             FROM users u
             LEFT JOIN roles r ON r.id = u.id_role
            WHERE u.active = 1 AND u.id_role = ?
            ORDER BY u.id ASC`,
          [roleId]
        );
        res.status(200).json({
          clients: rows.map((u) => ({
            ...mapUser(u, { id: u.id_role || 0, name: u.role_name }),
            packagesCount: Number(u.packages_count || 0),
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
          [name, lastname, number, email, hash, roleId]
        );
        res.status(201).json({ ok: true, id: r.insertId });
        return;
      }

      case "PUT":
      case "PATCH": {
        const b = (req.body || {}) as Record<string, unknown>;
        const id = Number(b.id || 0);
        if (!id) {
          res.status(400).json({ error: "Falta el id del cliente" });
          return;
        }
        // Solo clientes: evita editar admins desde este modulo
        const isClient = await q(`SELECT id FROM users WHERE id = ? AND id_role = ? AND active = 1`, [id, roleId]);
        if (!isClient.length) {
          res.status(404).json({ error: "Cliente no encontrado" });
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
        if (!fields.length) {
          res.status(400).json({ error: "Nada que actualizar" });
          return;
        }
        await exec(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`, [...params, id]);
        res.status(200).json({ ok: true });
        return;
      }

      case "DELETE": {
        const id = Number(req.query.id || 0);
        if (!id) {
          res.status(400).json({ error: "Falta el id del cliente" });
          return;
        }
        const r = await exec(
          `UPDATE users SET active = 0 WHERE id = ? AND id_role = ?`,
          [id, roleId]
        );
        if (!r.affectedRows) {
          res.status(404).json({ error: "Cliente no encontrado" });
          return;
        }
        res.status(200).json({ ok: true });
        return;
      }

      default:
        res.status(405).json({ error: "Metodo no permitido" });
    }
  } catch (e) {
    console.error("[admin/clients]", e);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});
