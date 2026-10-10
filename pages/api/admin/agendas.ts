import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { q, exec } from "../../../lib/db";

// ==================================================================
// Agendas de eventos por paquete comprado  ->  /api/admin/agendas
//   GET     ?userId=N | ?purchasedPackageId=N | ?from=YYYY-MM-DD&to=YYYY-MM-DD
//           lista agendas (fecha/hora + servicio + cliente/paquete)
//   POST    { purchasedPackageId, serviceId?, eventDate, description? }
//   PUT     { id, serviceId?, eventDate?, description? }
//   DELETE  ?id=N  baja lógica (active = 0)
//
// Permiso por acción sobre el módulo "agendas" (Admin pasa siempre).
// Las agendas se crean desde el paquete comprado del cliente y se pueden
// crear VARIAS por servicio.
// ==================================================================

const norm = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Normaliza una fecha/hora a "YYYY-MM-DD HH:MM:SS".
 * Acepta "YYYY-MM-DDTHH:MM:SS", "YYYY-MM-DD HH:MM:SS" y variantes sin
 * segundos. Devuelve null si el formato no es válido.
 */
function normalizeDateTime(raw: unknown): string | null {
  const value = norm(raw);
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  let out = value.replace("T", " ");
  if (out.length === 16) out += ":00"; // sin segundos -> :00
  return out;
}

/** Valida que un servicio exista y esté activo. */
async function serviceExists(id: number): Promise<boolean> {
  const rows = await q<{ id: number }>(
    `SELECT id FROM services WHERE id = ? AND active = 1`,
    [id]
  );
  return rows.length > 0;
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
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
  if (!(await requirePermission(req, res, "agendas", action))) return;

  try {
    switch (req.method) {
      case "GET": {
        const where: string[] = [`a.active = 1`];
        const params: unknown[] = [];

        const userId = Number(req.query.userId || 0);
        if (userId) {
          where.push(
            `a.id_purchased_package IN (SELECT id_purchased_package FROM users_packages WHERE id_user = ? AND active = 1)`
          );
          params.push(userId);
        }

        const purchasedPackageId = Number(req.query.purchasedPackageId || 0);
        if (purchasedPackageId) {
          where.push(`a.id_purchased_package = ?`);
          params.push(purchasedPackageId);
        }

        const from = norm(req.query.from);
        if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
          where.push(`DATE(a.event_date) >= ?`);
          params.push(from);
        }
        const to = norm(req.query.to);
        if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
          where.push(`DATE(a.event_date) <= ?`);
          params.push(to);
        }

        const rows = await q<{
          id: number;
          id_purchased_package: number | null;
          description: string | null;
          event_date: string | null;
          package_name: string | null;
          service_id: number | null;
          service_name: string | null;
          client_id: number | null;
          client_name: string | null;
        }>(
          `SELECT a.id, a.id_purchased_package, a.description,
                  DATE_FORMAT(a.event_date, '%Y-%m-%dT%H:%i:%s') AS event_date,
                  pp.name AS package_name,
                  s.id AS service_id, s.name AS service_name,
                  (SELECT u2.id FROM users_packages up2
                     JOIN users u2 ON u2.id = up2.id_user
                    WHERE up2.id_purchased_package = a.id_purchased_package
                      AND up2.active = 1 AND u2.active = 1
                    ORDER BY up2.id LIMIT 1) AS client_id,
                  (SELECT TRIM(CONCAT(u2.name, ' ', COALESCE(u2.lastname, '')))
                     FROM users_packages up2
                     JOIN users u2 ON u2.id = up2.id_user
                    WHERE up2.id_purchased_package = a.id_purchased_package
                      AND up2.active = 1 AND u2.active = 1
                    ORDER BY up2.id LIMIT 1) AS client_name
             FROM agendas a
             LEFT JOIN purchased_packages pp ON pp.id = a.id_purchased_package
             LEFT JOIN services s ON s.id = a.id_service
            WHERE ${where.join(" AND ")}
            ORDER BY a.event_date ASC, a.id ASC`,
          params
        );

        res.status(200).json({
          agendas: rows.map((r) => ({
            id: r.id,
            purchasedPackageId: r.id_purchased_package,
            userId: r.client_id ?? null,
            clientName: String(r.client_name || ""),
            packageName: String(r.package_name || ""),
            serviceId: r.service_id ?? null,
            serviceName: String(r.service_name || ""),
            eventDate: String(r.event_date || ""),
            description: String(r.description || ""),
          })),
        });
        return;
      }

      case "POST": {
        const b = (req.body || {}) as Record<string, unknown>;
        const purchasedPackageId = Number(b.purchasedPackageId || 0);
        if (!purchasedPackageId) {
          res.status(400).json({ error: "Indica el paquete comprado" });
          return;
        }
        const eventDate = normalizeDateTime(b.eventDate ?? b.datetime);
        if (!eventDate) {
          res.status(400).json({ error: "Fecha y hora invalida" });
          return;
        }
        const pkg = await q(
          `SELECT id FROM purchased_packages WHERE id = ? AND active = 1`,
          [purchasedPackageId]
        );
        if (!pkg.length) {
          res.status(404).json({ error: "Paquete comprado no encontrado" });
          return;
        }
        const serviceId =
          Number(b.serviceId ?? b.id_service ?? 0) || null;
        if (serviceId && !(await serviceExists(serviceId))) {
          res.status(400).json({ error: "Servicio inexistente" });
          return;
        }
        const description = norm(b.description);
        const r = await exec(
          `INSERT INTO agendas (id_purchased_package, id_service, event_date, description)
           VALUES (?, ?, ?, ?)`,
          [purchasedPackageId, serviceId, eventDate, description || null]
        );
        res.status(201).json({ ok: true, id: r.insertId });
        return;
      }

      case "PUT":
      case "PATCH": {
        const b = (req.body || {}) as Record<string, unknown>;
        const id = Number(b.id || 0);
        if (!id) {
          res.status(400).json({ error: "Falta el id de la agenda" });
          return;
        }
        const exists = await q(
          `SELECT id FROM agendas WHERE id = ? AND active = 1`,
          [id]
        );
        if (!exists.length) {
          res.status(404).json({ error: "Agenda no encontrada" });
          return;
        }

        const fields: string[] = [];
        const params: unknown[] = [];

        if (b.serviceId !== undefined || b.id_service !== undefined) {
          const serviceId = Number(b.serviceId ?? b.id_service ?? 0) || null;
          if (serviceId && !(await serviceExists(serviceId))) {
            res.status(400).json({ error: "Servicio inexistente" });
            return;
          }
          fields.push("`id_service` = ?");
          params.push(serviceId);
        }
        if (b.eventDate !== undefined || b.datetime !== undefined) {
          const eventDate = normalizeDateTime(b.eventDate ?? b.datetime);
          if (!eventDate) {
            res.status(400).json({ error: "Fecha y hora invalida" });
            return;
          }
          fields.push("`event_date` = ?");
          params.push(eventDate);
        }
        if (b.description !== undefined) {
          const description = norm(b.description);
          fields.push("`description` = ?");
          params.push(description || null);
        }
        if (!fields.length) {
          res.status(400).json({ error: "Nada que actualizar" });
          return;
        }

        await exec(
          `UPDATE agendas SET ${fields.join(", ")} WHERE id = ?`,
          [...params, id]
        );
        res.status(200).json({ ok: true });
        return;
      }

      case "DELETE": {
        const id = Number(req.query.id || 0);
        if (!id) {
          res.status(400).json({ error: "Falta el id de la agenda" });
          return;
        }
        const r = await exec(`UPDATE agendas SET active = 0 WHERE id = ?`, [id]);
        if (!r.affectedRows) {
          res.status(404).json({ error: "Agenda no encontrada" });
          return;
        }
        res.status(200).json({ ok: true });
        return;
      }

      default:
        res.status(405).json({ error: "Metodo no permitido" });
    }
  } catch (e) {
    console.error("[admin/agendas]", e);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});
