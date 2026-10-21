import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { q, exec } from "../../../lib/db";
import { ok, created, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";
import { readPaging, pageMeta } from "../../../lib/pagination";
import { requestScope, scopeFilterOn } from "../../../lib/company-scope";
import {
  agendaForViewer,
  clientPackageIds,
  viewerIsClient,
  type AgendaItem,
  type AgendaLocation,
} from "../../../lib/agenda-visibility";

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
//
// VISIBILIDAD PARA CLIENTES: un cliente (rol "Cliente" o usuario con
// paquetes comprados) recibe sus eventos completos y los de los demás como
// huecos "ocupado" (sin cliente, paquete, servicio, nota ni lugar). El
// enmascarado se hace AQUÍ, en el servidor (ver lib/agenda-visibility.ts).
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

/** Una ubicación ya normalizada (nombre + coordenadas). */
type PlaceInput = { location: string; lat: number | null; lng: number | null };

/**
 * TODAS las ubicaciones que llegan en el cuerpo.
 *
 * Acepta la forma nueva `locations: [{ location, lat, lng }, ...]` (en el
 * orden en que se capturaron) y la forma vieja de UNA sola
 * (`location` + `lat`/`lng`, o un simple texto entre las ubicaciones).
 * Las entradas vacías se descartan: así la numeración queda 1, 2, 3 sin
 * huecos.
 */
function locationsOf(b: Record<string, unknown>): PlaceInput[] {
  const raw = b.locations ?? b.places ?? b.ubicaciones;
  const list: PlaceInput[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry === null || entry === undefined) continue;
      if (typeof entry !== "string" && typeof entry !== "object") continue;
      const rec = (typeof entry === "string"
        ? { location: entry }
        : entry) as Record<string, unknown>;
      const location = norm(
        rec.location ?? rec.name ?? rec.place ?? rec.lugar
      ).slice(0, 255);
      const lat = coordinate(rec.lat ?? rec.latitude, 90);
      const lng = coordinate(rec.lng ?? rec.lon ?? rec.longitude, 180);
      if (!location && (lat === null || lng === null)) continue;
      list.push({ location, lat, lng });
    }
  }
  if (!list.length) {
    const one = placeOf(b);
    if (one.location || (one.lat !== null && one.lng !== null)) list.push(one);
  }
  return list;
}

/**
 * Guarda las ubicaciones de una agenda: da de baja las que había y escribe las
 * nuevas numeradas 1..N (el número es el orden de captura).
 *
 * Sin la migración (`schedule_locations` no existe) no falla: la agenda sigue
 * guardando su primera ubicación en `schedules.location`.
 */
async function replaceScheduleLocations(
  scheduleId: number,
  companyId: number | null,
  locations: PlaceInput[]
): Promise<void> {
  try {
    await exec(
      `UPDATE schedule_locations SET active = 0 WHERE id_schedule = ?`,
      [scheduleId]
    );
    for (let i = 0; i < locations.length; i++) {
      const l = locations[i];
      await exec(
        `INSERT INTO schedule_locations
           (id_schedule, id_company, position, location, lat, lng)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [scheduleId, companyId, i + 1, l.location || null, l.lat, l.lng]
      );
    }
  } catch {
    // Migración pendiente: el lugar principal vive en la propia agenda.
  }
}

/** Valida que un servicio exista, esté activo y sea de la empresa. */
async function serviceExists(id: number, companyId: number): Promise<boolean> {
  const rows = await q<{ id: number }>(
    `SELECT id FROM services WHERE id = ? AND active = 1 AND id_company = ?`,
    [id, companyId]
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

  // Alcance por empresa: las agendas de un estudio no se mezclan con otro.
  const scope = await requestScope(req, me);
  const scopeSql = scopeFilterOn(scope, "a");
  const companyId = scope.writeCompanyId;

  try {
    switch (req.method) {
      case "GET": {
        const where: string[] = [`a.active = 1`, scopeSql.sql];
        const params: unknown[] = [...scopeSql.params];

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

        // UBICACIONES de cada agenda, ya numeradas (1, 2, 3…). Sin la
        // migración no hay ninguna y el detalle usa `location`.
        const locationsBySchedule = new Map<number, AgendaLocation[]>();
        const scheduleIds = rows.map((r) => Number(r.id));
        if (scheduleIds.length) {
          try {
            const locRows = await q<{
              id: number;
              id_schedule: number;
              position: number;
              location: string | null;
              lat: string | number | null;
              lng: string | number | null;
            }>(
              `SELECT id, id_schedule, position, location, lat, lng
                 FROM schedule_locations
                WHERE active = 1 AND id_schedule IN (?)
                ORDER BY id_schedule ASC, position ASC, id ASC`,
              [scheduleIds]
            );
            for (const l of locRows) {
              const key = Number(l.id_schedule);
              const list = locationsBySchedule.get(key) ?? [];
              list.push({
                id: Number(l.id),
                position: Number(l.position) || list.length + 1,
                location: String(l.location || ""),
                lat:
                  l.lat === null || l.lat === undefined ? null : Number(l.lat),
                lng:
                  l.lng === null || l.lng === undefined ? null : Number(l.lng),
              });
              locationsBySchedule.set(key, list);
            }
          } catch {
            // Migración pendiente: cada agenda sigue con su lugar único.
          }
        }

        // ¿Quién mira? Si es CLIENTE, solo sus eventos llevan detalle; los
        // demás se devuelven como huecos ocupados (la app pinta "Ocupado").
        const isClient = await viewerIsClient(me.sub);
        const ownPackages = isClient
          ? new Set(await clientPackageIds(me.sub))
          : null;

        const agendas = rows.map((r) => {
          const places = locationsBySchedule.get(Number(r.id)) ?? [];
          const primary = places[0];
          const item: AgendaItem = {
            id: r.id,
            purchasedPackageId: r.id_purchased_package,
            userId: r.client_id ?? null,
            clientName: String(r.client_name || ""),
            packageName: String(r.package_name || ""),
            serviceId: r.service_id ?? null,
            serviceName: String(r.service_name || ""),
            eventDate: String(r.event_date || ""),
            description: String(r.description || ""),
            // El LUGAR: la PRIMERA ubicación en los campos sueltos (para el
            // calendario y el widget) y TODAS en `locations` (numeradas).
            location: String(primary?.location ?? r.location ?? ""),
            lat:
              primary?.lat ??
              (r.lat === null || r.lat === undefined ? null : Number(r.lat)),
            lng:
              primary?.lng ??
              (r.lng === null || r.lng === undefined ? null : Number(r.lng)),
            locations: places,
            busy: false,
          };
          return agendaForViewer(item, isClient, ownPackages);
        });

        res.status(200).json({
          ...pageMeta(countRows[0]?.n, p),
          // Se lo decimos a la app para que la franja de "próximos eventos"
          // y el widget sepan que el calendario viene en modo cliente.
          clientView: isClient,
          agendas,
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
          `SELECT id FROM purchased_packages
            WHERE id = ? AND active = 1 AND id_company = ?`,
          [purchasedPackageId, companyId]
        );
        if (!pkg.length) {
          fail(res, 404, "Paquete comprado no encontrado", `No hay un paquete con id ${purchasedPackageId}`);
          return;
        }
        const serviceId =
          Number(b.serviceId ?? b.id_service ?? 0) || null;
        if (serviceId && !(await serviceExists(serviceId, companyId))) {
          fail(res, 400, "Servicio inexistente", `No hay un servicio activo con id ${serviceId}`);
          return;
        }
        const description = norm(b.description);
        // VARIAS ubicaciones: la primera va también en la agenda (el
        // calendario y el widget siguen leyendo un solo lugar).
        const locations = locationsOf(b);
        const location = locations[0]?.location || "";
        const lat = locations[0]?.lat ?? null;
        const lng = locations[0]?.lng ?? null;
        // Con la migración del lugar se guarda también DÓNDE es; sin ella, la
        // agenda se guarda igual (no se pierde la fecha ni la nota).
        let r: { insertId: number; affectedRows: number };
        try {
          r = await exec(
            `INSERT INTO schedules
               (id_purchased_package, id_service, event_date, description,
                location, lat, lng, id_company)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              purchasedPackageId,
              serviceId,
              eventDate,
              description || null,
              location || null,
              lat,
              lng,
              companyId,
            ]
          );
        } catch {
          r = await exec(
            `INSERT INTO schedules
               (id_purchased_package, id_service, event_date, description, id_company)
             VALUES (?, ?, ?, ?, ?)`,
            [purchasedPackageId, serviceId, eventDate, description || null, companyId]
          );
        }
        // Numeradas 1..N en el orden en que se capturaron.
        await replaceScheduleLocations(r.insertId, companyId, locations);
        const item = {
          id: r.insertId,
          purchasedPackageId,
          serviceId,
          eventDate,
          description,
          location,
          lat,
          lng,
          locations,
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
          `SELECT id FROM schedules WHERE id = ? AND active = 1 AND ${scopeSql.sql}`,
          [id, ...scopeSql.params]
        );
        if (!exists.length) {
          fail(res, 404, "Agenda no encontrada", `No hay una agenda activa con id ${id}`);
          return;
        }

        const fields: string[] = [];
        const params: unknown[] = [];

        if (b.serviceId !== undefined || b.id_service !== undefined) {
          const serviceId = Number(b.serviceId ?? b.id_service ?? 0) || null;
          if (serviceId && !(await serviceExists(serviceId, companyId))) {
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
        // UBICACIONES: si llega la lista se REEMPLAZA completa y la primera
        // pasa a ser el lugar principal de la agenda (numeradas 1..N).
        // Sin lista se mantiene la forma vieja de UNA sola ubicación.
        const newLocations =
          b.locations !== undefined ||
          b.places !== undefined ||
          b.ubicaciones !== undefined
            ? locationsOf(b)
            : null;
        const place =
          newLocations && newLocations.length ? newLocations[0] : placeOf(b);
        const extraFields: string[] = [];
        const extraParams: unknown[] = [];
        if (newLocations) {
          extraFields.push("`location` = ?", "`lat` = ?", "`lng` = ?");
          extraParams.push(place.location || null, place.lat, place.lng);
        }
        if (!newLocations && (b.location !== undefined || b.place !== undefined)) {
          extraFields.push("`location` = ?");
          extraParams.push(place.location || null);
        }
        if (!newLocations && (b.lat !== undefined || b.latitude !== undefined)) {
          extraFields.push("`lat` = ?");
          extraParams.push(place.lat);
        }
        if (
          !newLocations &&
          (b.lng !== undefined || b.lon !== undefined || b.longitude !== undefined)
        ) {
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
            `UPDATE schedules SET ${[...fields, ...extraFields].join(", ")}
              WHERE id = ? AND ${scopeSql.sql}`,
            [...params, ...extraParams, id, ...scopeSql.params]
          );
        } catch (e) {
          if (!fields.length) throw e;
          await exec(
            `UPDATE schedules SET ${fields.join(", ")} WHERE id = ? AND ${scopeSql.sql}`,
            [...params, id, ...scopeSql.params]
          );
        }
        // La lista de ubicaciones se reescribe completa (1, 2, 3…).
        if (newLocations) {
          await replaceScheduleLocations(id, companyId, newLocations);
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
            ...(newLocations ? { locations: newLocations } : {}),
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
        const r = await exec(
          `UPDATE schedules SET active = 0 WHERE id = ? AND ${scopeSql.sql}`,
          [id, ...scopeSql.params]
        );
        if (!r.affectedRows) {
          fail(res, 404, "Agenda no encontrada", `No hay una agenda activa con id ${id}`);
          return;
        }
        // Sus ubicaciones se van con ella (baja lógica).
        try {
          await exec(
            `UPDATE schedule_locations SET active = 0 WHERE id_schedule = ?`,
            [id]
          );
        } catch {
          // Migración pendiente: no hay ubicaciones que dar de baja.
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
