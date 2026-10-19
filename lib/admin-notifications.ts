// ==================================================================
// HARD STREET BACKEND — Avisos para el EQUIPO (administradores y
// colaboradores)
// ==================================================================
// Tabla (migración 2026-10-19_avisos_equipo.sql):
//
//   admin_notifications  un aviso por USUARIO del equipo
//
// Cuándo se generan: cuando un cliente toca «Enviar a impresión» en
// «Mi paquete». Se avisa a TODOS los administradores y a los colaboradores
// cuyo rol tiene permiso sobre el módulo Impresiones (el mismo que abre el
// módulo), así nadie se entera tarde de un trabajo nuevo.
//
// Los avisos se leen en la MISMA campanita de la top bar: `GET /api/reminders`
// los devuelve mezclados con los recordatorios de eventos, marcados con
// `source: "print"`. Así no hay dos campanitas que revisar.
//
// SIN la migración aplicada nada falla: las lecturas devuelven listas vacías
// y el envío del cliente termina igual.
// ==================================================================

import { q, exec } from "./db";

export type AdminNotification = {
  id: number;
  kind: string;
  title: string;
  body: string;
  isRead: boolean;
  created: string;
  printRequestId: number | null;
  serviceId: number | null;
};

const MAX_TITLE = 200;
const MAX_BODY = 500;

const text = (v: unknown) =>
  String(v ?? "").replace(/\s+/g, " ").trim();

/**
 * Usuarios del EQUIPO que deben enterarse de un envío a impresión:
 * todos los administradores y colaboradores activos + cualquier otro rol
 * (p. ej. Empleado) al que se le haya dado permiso sobre Impresiones.
 *
 * Los colaboradores entran SIEMPRE, aunque su rol todavía no tenga los
 * permisos del módulo: el aviso es justo para que se enteren del trabajo
 * nuevo.
 */
export async function printRecipientIds(): Promise<number[]> {
  try {
    const rows = await q<{ id: number }>(
      `SELECT DISTINCT u.id
         FROM users u
         JOIN roles r ON r.id = u.id_role AND r.active = 1
        WHERE u.active = 1
          AND (
            LOWER(r.name) IN ('admin', 'colaborador')
            OR EXISTS (
              SELECT 1
                FROM permissions_roles pr
                JOIN modules m ON m.id = pr.id_modules AND m.active = 1
               WHERE pr.active = 1
                 AND pr.id_role = r.id
                 AND (LOWER(m.\`module\`) IN ('print', 'impresiones')
                      OR LOWER(m.name)    IN ('print', 'impresiones'))
            )
          )`
    );
    return rows.map((r) => Number(r.id)).filter((n) => n > 0);
  } catch {
    return [];
  }
}

/**
 * Avisa al equipo de un envío a impresión. Idempotente por
 * (usuario, envío): reintentar la petición no duplica avisos.
 * Devuelve cuántos avisos se crearon.
 */
export async function notifyPrintRequest(input: {
  requestId: number;
  serviceId?: number | null;
  clientName?: string;
  serviceName?: string;
  packageName?: string;
  photos?: number;
}): Promise<number> {
  const requestId = Number(input.requestId) || 0;
  if (!requestId) return 0;

  const count = Math.max(0, Number(input.photos) || 0);
  const client = text(input.clientName) || "Un cliente";
  const service = text(input.serviceName) || "Servicio";
  const packageName = text(input.packageName);

  const title = `Nuevo envío a impresión · ${service}`.slice(0, MAX_TITLE);
  const body = [
    `${client} envió ${count || "varias"} ${count === 1 ? "foto" : "fotos"} a impresión`,
    packageName ? `Paquete: ${packageName}` : "",
  ]
    .filter(Boolean)
    .join(" · ")
    .slice(0, MAX_BODY);

  const recipients = await printRecipientIds();
  if (!recipients.length) return 0;

  try {
    // Solo a quien todavía no tiene el aviso de ESE envío.
    const already = await q<{ id_user: number }>(
      `SELECT id_user FROM admin_notifications
        WHERE active = 1 AND id_print_request = ?
          AND id_user IN (?)`,
      [requestId, recipients]
    );
    const skip = new Set(already.map((r) => Number(r.id_user)));
    const pending = recipients.filter((id) => !skip.has(id));
    if (!pending.length) return 0;

    const values: unknown[] = [];
    const rows = pending.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
    for (const id of pending) {
      values.push(
        id,
        requestId,
        input.serviceId ?? null,
        "print",
        title,
        body
      );
    }
    await exec(
      `INSERT INTO admin_notifications
         (id_user, id_print_request, id_purchased_package_service,
          kind, title, body)
       VALUES ${rows}`,
      values
    );
    return pending.length;
  } catch {
    // Migración pendiente: el envío del cliente no se cae por un aviso.
    return 0;
  }
}

/** Avisos del equipo para UN usuario (más nuevos primero). */
export async function listAdminNotifications(
  userId: number,
  limit = 40
): Promise<AdminNotification[]> {
  const take = Math.max(1, Math.min(100, Number(limit) || 40));
  try {
    const rows = await q<{
      id: number;
      kind: string;
      title: string;
      body: string;
      is_read: number;
      created: string;
      id_print_request: number | null;
      id_purchased_package_service: number | null;
    }>(
      `SELECT id, kind, title, body, is_read,
              DATE_FORMAT(created, '%Y-%m-%dT%H:%i:%s') AS created,
              id_print_request, id_purchased_package_service
         FROM admin_notifications
        WHERE active = 1 AND id_user = ?
        ORDER BY id DESC
        LIMIT ${take}`,
      [userId]
    );
    return rows.map((r) => ({
      id: Number(r.id),
      kind: String(r.kind || "print"),
      title: String(r.title || ""),
      body: String(r.body || ""),
      isRead: Number(r.is_read) === 1,
      created: String(r.created || ""),
      printRequestId:
        r.id_print_request === null ? null : Number(r.id_print_request),
      serviceId:
        r.id_purchased_package_service === null
          ? null
          : Number(r.id_purchased_package_service),
    }));
  } catch {
    return [];
  }
}

/** Marca leídos unos avisos del equipo (o TODOS si no se indican ids). */
export async function markAdminNotificationsRead(
  userId: number,
  ids: number[] = []
): Promise<number> {
  const clean = ids
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0);
  try {
    if (clean.length) {
      const r = await exec(
        `UPDATE admin_notifications
            SET is_read = 1
          WHERE id_user = ? AND active = 1 AND is_read = 0 AND id IN (?)`,
        [userId, clean]
      );
      return Number(r.affectedRows || 0);
    }
    const r = await exec(
      `UPDATE admin_notifications
          SET is_read = 1
        WHERE id_user = ? AND active = 1 AND is_read = 0`,
      [userId]
    );
    return Number(r.affectedRows || 0);
  } catch {
    return 0;
  }
}
