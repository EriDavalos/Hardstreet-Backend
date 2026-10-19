import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { q, exec } from "../../../lib/db";
import { ok, created, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";
import { readPaging, pageMeta } from "../../../lib/pagination";

// ==================================================================
// Agendas de eventos por paquete comprado  ->  /api/admin/agendas
//   GET     ?userId=N | ?purchasedPackageId=N | ?from=YYYY-MM-DD&to=YYYY-MM-DD
//           lista agendas (fecha/hora + servicio + cliente/paquete + lugar)
//   POST    { purchasedPackageId, serviceId?, eventDate, description?,
//             location?, lat?, lng? }
//   PUT     { id, serviceId?, eventDate?, description?, location?, lat?, lng? }
//   DELETE  ?id=N  baja lógica (active = 0)
//
// Tabla `schedules` (migración 2026-10-11: antes `agendas`).
//
// El LUGAR (migración 2026-10-19: `location` + `lat`/`lng`) es opcional y se
// elige con el mapa del panel; sin la migración todo sigue funcionando (se
// guarda la fecha y la nota, y el lugar simplemente no existe).
// Permiso por acción sobre el módulo "schedules" (Admin pasa siempre).
// Las agendas se crean desde el paquete comprado del cliente y se pueden
// crear VARIAS por servicio.
// ==================================================================

const norm = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Una fila del listado de agendas (con el lugar, si la migración está puesta). */
type AgendaRow = {
  id: number;
  id_purchased_package: number | null;
  description: string | null;
  event_date: string | null;
  package_name: string | null;
  service_id: number | null;
  service_name: string | null;
  client_id: number | null;
  client_name: string | null;
  location?: string | null;
  lat?: string | number | null;
  lng?: string | number | null;
};

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

/** Coordenada válida (-90..90 / -180..180) o null si no viene o no cuadra. */
function coordinate(raw: unknown, max: number): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.abs(n) > max) return null;
  return Number(n.toFixed(7));
}

/** El lugar de la agenda: nombre + coordenadas ("" / null = sin lugar). */
function placeOf(b: Record<string, unknown>) {
  const location = norm(b.location ?? b.place ?? b.lugar).slice(0, 255);
  const lat = coordinate(b.lat ?? b.latitude, 90);
  const lng = coordinate(b.lng ?? b.lon ?? b.longitude, 180);
  return { location, lat, lng };
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
    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
    return;
  }
  const me = await requirePermission(req, res, "schedules", action);
  if (!me) return;

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

        // Paginado: ?page=1&limit=30 además de los filtros de arriba.
        const p = readPaging(req);
        const countRows = await q<{ n: number }>(
          `SELECT COUNT(*) AS n FROM schedules a WHERE ${where.join(" AND ")}`,
          params
        );
        // El LUGAR puede no existir todavía (migración pendiente): se pide con
        // sus columnas y, si la base no las tiene, se pide sin ellas. Así el
        // calendario sigue funcionando en una BD sin migrar.
        const selectAgendas = (place: string) =>
          `SELECT a.id, a.id_purchased_package, a.description,
                  DATE_FORMAT(a.event_date, '%Y-%m-%dT%H:%i:%s') AS event_date,
                  ${place}
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
             FROM schedules a
             LEFT JOIN purchased_packages pp ON pp.id = a.id_purchased_package
             LEFT JOIN services s ON s.id = a.id_service
            WHERE ${where.join(" AND ")}
            ORDER BY a.event_date ASC, a.id ASC
            LIMIT ${p.limit} OFFSET ${p.offset}`;

        let rows: AgendaRow[];
        try {
          rows = await q<AgendaRow>(selectAgendas("a.location, a.lat, a.lng,"), params);
        } catch {
          rows = await q<AgendaRow>(selectAgendas(""), params);
        }

        res.status(200).json({
          ...pageMeta(countRows[0]?.n, p),
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
            // El LUGAR: nombre y coordenadas (null si la agenda no lo tiene).
            location: String(r.location || ""),
            lat: r.lat === null || r.lat === undefined ? null : Number(r.lat),
            lng: r.lng === null || r.lng === undefined ? null : Number(r.lng),
          })),
        });
        return;
      }

      case "POST": {
        const b = (req.body || {}) as Record<string, unknown>;
        const purchasedPackageId = Number(b.purchasedPackageId || 0);
        if (!purchasedPackageId) {
          fail(res, 400, "Indica el paquete comprado", "La agenda debe pertenecer a un paquete del cliente");
          return;
        }
        const eventDate = normalizeDateTime(b.eventDate ?? b.datetime);
        if (!eventDate) {
          fail(res, 400, "Fecha y hora inválida", "Usa el formato YYYY-MM-DD HH:MM");
          return;
        }
        const pkg = await q(
          `SELECT id FROM purchased_packages WHERE id = ? AND active = 1`,
          [purchasedPackageId]
        );
        if (!pkg.length) {
          fail(res, 404, "Paquete comprado no encontrado", `No hay un paquete con id ${purchasedPackageId}`);
          return;
        }
        const serviceId =
          Number(b.serviceId ?? b.id_service ?? 0) || null;
        if (serviceId && !(await serviceExists(serviceId))) {
          fail(res, 400, "Servicio inexistente", `No hay un servicio activo con id ${serviceId}`);
          return;
        }
        const description = norm(b.description);
        const { location, lat, lng } = placeOf(b);
        // Con la migración del lugar se guarda también DÓNDE es; sin ella, la
        // agenda se guarda igual (no se pierde la fecha ni la nota).
        let r: { insertId: number; affectedRows: number };
        try {
          r = await exec(
            `INSERT INTO schedules
               (id_purchased_package, id_service, event_date, description,
                location, lat, lng)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              purchasedPackageId,
              serviceId,
              eventDate,
              description || null,
              location || null,
              lat,
              lng,
            ]
          );
        } catch {
          r = await exec(
            `INSERT INTO schedules (id_purchased_package, id_service, event_date, description)
             VALUES (?, ?, ?, ?)`,
            [purchasedPackageId, serviceId, eventDate, description || null]
          );
        }
        const item = {
          id: r.insertId,
          purchasedPackageId,
          serviceId,
          eventDate,
          description,
          location,
          lat,
          lng,
        };
        await logActivity({
          userId: me.sub,
          module: "schedules",
          moduleName: "Agendas",
          action: "create",
          entity: "agenda",
          entityId: r.insertId,
          description: "Agenda creada exitosamente",
          details: item,
          req,
        });
        created(res, "Agenda creada exitosamente", { item });
        return;
      }

      case "PUT":
      case "PATCH": {
        const b = (req.body || {}) as Record<string, unknown>;
        const id = Number(b.id || 0);
        if (!id) {
          fail(res, 400, "Falta el id de la agenda", "Indica qué agenda quieres modificar");
          return;
        }
        const exists = await q(
          `SELECT id FROM schedules WHERE id = ? AND active = 1`,
          [id]
        );
        if (!exists.length) {
          fail(res, 404, "Agenda no encontrada", `No hay una agenda activa con id ${id}`);
          return;
        }

        const fields: string[] = [];
        const params: unknown[] = [];

        if (b.serviceId !== undefined || b.id_service !== undefined) {
          const serviceId = Number(b.serviceId ?? b.id_service ?? 0) || null;
          if (serviceId && !(await serviceExists(serviceId))) {
            fail(res, 400, "Servicio inexistente", `No hay un servicio activo con id ${serviceId}`);
            return;
          }
          fields.push("`id_service` = ?");
          params.push(serviceId);
        }
        if (b.eventDate !== undefined || b.datetime !== undefined) {
          const eventDate = normalizeDateTime(b.eventDate ?? b.datetime);
          if (!eventDate) {
            fail(res, 400, "Fecha y hora inválida", "Usa el formato YYYY-MM-DD HH:MM");
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
        // LUGAR: se puede fijar, cambiar o quitar (location vacío = sin lugar).
        const place = placeOf(b);
        const extraFields: string[] = [];
        const extraParams: unknown[] = [];
        if (b.location !== undefined || b.place !== undefined) {
          extraFields.push("`location` = ?");
          extraParams.push(place.location || null);
        }
        if (b.lat !== undefined || b.latitude !== undefined) {
          extraFields.push("`lat` = ?");
          extraParams.push(place.lat);
        }
        if (b.lng !== undefined || b.lon !== undefined || b.longitude !== undefined) {
          extraFields.push("`lng` = ?");
          extraParams.push(place.lng);
        }
        if (!fields.length && !extraFields.length) {
          fail(res, 400, "Nada que actualizar", "No enviaste ningún campo de la agenda");
          return;
        }

        // Sin la migración del lugar, una actualización que solo toca el lugar
        // no tiene nada que guardar: se dice en vez de fingir que se guardó.
        try {
          await exec(
            `UPDATE schedules SET ${[...fields, ...extraFields].join(", ")} WHERE id = ?`,
            [...params, ...extraParams, id]
          );
        } catch (e) {
          if (!fields.length) throw e;
          await exec(
            `UPDATE schedules SET ${fields.join(", ")} WHERE id = ?`,
            [...params, id]
          );
        }
        await logActivity({
          userId: me.sub,
          module: "schedules",
          moduleName: "Agendas",
          action: "update",
          entity: "agenda",
          entityId: id,
          description: "Agenda actualizada exitosamente",
          details: { id, ...b },
          req,
        });
        ok(res, "Agenda actualizada exitosamente", {
          item: {
            id,
            eventDate: b.eventDate ?? b.datetime,
            description: b.description,
            location: place.location,
            lat: place.lat,
            lng: place.lng,
          },
        });
        return;
      }

      case "DELETE": {
        const id = Number(req.query.id || 0);
        if (!id) {
          fail(res, 400, "Falta el id de la agenda", "Indica qué agenda quieres eliminar");
          return;
        }
        const r = await exec(`UPDATE schedules SET active = 0 WHERE id = ?`, [id]);
        if (!r.affectedRows) {
          fail(res, 404, "Agenda no encontrada", `No hay una agenda activa con id ${id}`);
          return;
        }
        await logActivity({
          userId: me.sub,
          module: "schedules",
          moduleName: "Agendas",
          action: "delete",
          entity: "agenda",
          entityId: id,
          description: "Agenda eliminada exitosamente",
          details: { id },
          req,
        });
        ok(res, "Agenda eliminada exitosamente", { item: { id } });
        return;
      }

      default:
        fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
    }
  } catch (e) {
    console.error("[admin/agendas]", e);
    fail(res, 500, "Hubo un error", "No se pudo completar la operación de la agenda");
  }
});
