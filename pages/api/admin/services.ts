import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { q, exec } from "../../../lib/db";

// ==================================================================
// Catálogo de SERVICIOS (módulo "Servicios") -> /api/admin/services
//   GET            lista TODO el catálogo (nombre, descripción, icono y url)
//   POST           crea servicio { name, description?, icon?, url? }
//   PUT/PATCH      actualiza { id, ...campos }
//   DELETE         baja lógica (?id=N) — active = 0
//
// `url` es OPCIONAL: la liga base del Drive afiliada al servicio. Se puede
// definir aquí o directo desde la pestaña Servicios del paquete comprado
// del cliente (acción "actualizar-servicio-url" de package-progress).
// Requiere la migración 2026-10-13_services_url.sql (columna services.url).
// ==================================================================

const norm = (v: unknown) => (typeof v === "string" ? v.trim() : "");

type Row = {
  id: number;
  name: string | null;
  description: string | null;
  icon: string | null;
  url: string | null;
};

function map(r: Row) {
  return {
    id: Number(r.id),
    name: r.name || "",
    description: r.description || "",
    icon: r.icon || "",
    url: r.url || "",
  };
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  // Permiso por acción sobre el módulo "Servicios" (Admin pasa siempre).
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
  if (!(await requirePermission(req, res, "Servicios", action))) return;

  try {
    if (req.method === "GET") {
      let rows: Row[];
      try {
        rows = await q<Row>(
          `SELECT id, name, description, icon, url
             FROM services
            WHERE active = 1
            ORDER BY id ASC`
        );
      } catch {
        // Migración 2026-10-13_services_url.sql aún no aplicada.
        rows = await q<Row>(
          `SELECT id, name, description, icon
             FROM services
            WHERE active = 1
            ORDER BY id ASC`
        );
      }
      res.status(200).json({ services: rows.map(map) });
      return;
    }

    if (req.method === "DELETE") {
      const id = Number(req.query.id || 0);
      if (!id) {
        res.status(400).json({ error: "Falta el servicio" });
        return;
      }
      const r = await exec(`UPDATE services SET active = 0 WHERE id = ?`, [id]);
      if (!r.affectedRows) {
        res.status(404).json({ error: "Servicio no encontrado" });
        return;
      }
      res.status(200).json({ ok: true });
      return;
    }

    const b = (req.body || {}) as Record<string, unknown>;
    const name = norm(b.name);
    const description = norm(b.description);
    const icon = norm(b.icon);
    const url = norm(b.url);

    if (req.method === "POST") {
      if (!name) {
        res.status(400).json({ error: "Escribe el nombre del servicio" });
        return;
      }
      const r = await exec(
        `INSERT INTO services (name, description, icon, url)
         VALUES (?, ?, ?, ?)`,
        [name, description || null, icon || null, url || null]
      );
      res.status(201).json({ ok: true, id: Number(r.insertId) });
      return;
    }

    // ---- PUT / PATCH: actualiza solo los campos enviados ----
    const id = Number(b.id || 0);
    if (!id) {
      res.status(400).json({ error: "Falta el servicio" });
      return;
    }
    const fields: string[] = [];
    const params: unknown[] = [];
    if (b.name !== undefined) {
      if (!name) {
        res.status(400).json({ error: "El nombre no puede ir vacío" });
        return;
      }
      fields.push("`name` = ?");
      params.push(name);
    }
    if (b.description !== undefined) {
      fields.push("`description` = ?");
      params.push(description || null);
    }
    if (b.icon !== undefined) {
      fields.push("`icon` = ?");
      params.push(icon || null);
    }
    if (b.url !== undefined) {
      fields.push("`url` = ?");
      params.push(url || null);
    }
    if (!fields.length) {
      res.status(400).json({ error: "Nada que actualizar" });
      return;
    }
    const r = await exec(
      `UPDATE services SET ${fields.join(", ")} WHERE id = ?`,
      [...params, id]
    );
    if (!r.affectedRows) {
      res.status(404).json({ error: "Servicio no encontrado" });
      return;
    }
    res.status(200).json({ ok: true });
    return;
  } catch (e) {
    console.error("[admin/services]", e);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});
