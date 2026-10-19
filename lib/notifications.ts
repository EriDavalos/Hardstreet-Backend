// ==================================================================
// HARD STREET BACKEND — Avisos del CLIENTE sobre su paquete
// ==================================================================
// El estudio avisa al cliente desde el administrador del paquete:
//
//   * «Ya puedes elegir tus fotos» (cuando enciende la selección).
//   * «Servicio terminado» (automático al completar un servicio).
//
// Los avisos viven en `package_notifications` (migración
// 2026-10-18_parametros_servicios.sql) y los lee el cliente en «Mi paquete»
// (`/api/my/notifications`). El panel del cliente además dispara una
// notificación NATIVA cuando aparece uno nuevo.
//
// SIN la migración aplicada nada falla: [notifyPackageUsers] devuelve 0 y las
// lecturas devuelven listas vacías. Así el panel y la web siguen funcionando
// con una base sin actualizar.
// ==================================================================

import { q, exec } from "./db";

export type PackageNotification = {
  id: number;
  kind: string;
  title: string;
  body: string;
  isRead: boolean;
  created: string;
  purchasedPackageId: number | null;
  serviceId: number | null;
  serviceName: string;
};

type NotifyInput = {
  purchasedPackageId: number;
  serviceId?: number | null;
  kind: string;
  title: string;
  body: string;
};

const MAX_TITLE = 200;
const MAX_BODY = 500;

/**
 * Ventana de idempotencia: dos avisos IDÉNTICOS (mismo paquete, servicio,
 * tipo, título y cuerpo) dentro de estos minutos son el MISMO aviso. Cubre el
 * doble toque en «Avisar al cliente», un reintento del panel o una petición
 * repetida por la red, aunque el cliente ya lo haya leído.
 */
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

const text = (v: unknown, max: number) =>
  String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** `fotos-disponibles`, `servicio-terminado`, `paquete`, … */
const kindOf = (v: unknown) => {
  const k = String(v ?? "paquete")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return k || "paquete";
};

/**
 * Avisa a TODOS los clientes activos de un paquete comprado.
 * Devuelve cuántos avisos se crearon (0 si no hay clientes o no hay tabla).
 */
export async function notifyPackageUsers(input: NotifyInput): Promise<number> {
  const purchasedPackageId = Number(input.purchasedPackageId) || 0;
  if (!purchasedPackageId) return 0;
  const title = text(input.title, MAX_TITLE);
  const body = text(input.body, MAX_BODY);
  if (!title) return 0;

  try {
    const users = await q<{ id_user: number }>(
      `SELECT DISTINCT up.id_user
         FROM users_packages up
        WHERE up.id_purchased_package = ? AND up.active = 1`,
      [purchasedPackageId]
    );
    const ids = users.map((u) => Number(u.id_user)).filter((n) => n > 0);
    if (!ids.length) return 0;

    const serviceId = Number(input.serviceId) || null;
    const kind = kindOf(input.kind);

    // NO DUPLICAR: si el cliente ya tiene ese MISMO aviso sin leer, o se le
    // creó hace menos de [DEDUPE_WINDOW_MS] (aunque ya lo haya leído), se
    // omite. Así pulsar dos veces «Avisar al cliente», un reintento del panel
    // o una petición repetida por la red no generan dos avisos.
    let already: number[] = [];
    try {
      const serviceCond =
        serviceId == null
          ? "id_purchased_package_service IS NULL"
          : "id_purchased_package_service = ?";
      const holes = ids.map(() => "?").join(", ");
      const rows = await q<{ id_user: number }>(
        `SELECT id_user FROM package_notifications
          WHERE active = 1
            AND id_purchased_package = ?
            AND ${serviceCond}
            AND kind = ? AND title = ?
            AND COALESCE(body, '') = ?
            AND (is_read = 0 OR created >= (NOW() - INTERVAL 10 MINUTE))
            AND id_user IN (${holes})`,
        [
          purchasedPackageId,
          ...(serviceId == null ? [] : [serviceId]),
          kind,
          title,
          body,
          ...ids,
        ]
      );
      already = rows.map((r) => Number(r.id_user));
    } catch {
      // Tabla/columna ausente (migración pendiente): se sigue como antes.
      already = [];
    }
    const pending = ids.filter((id) => !already.includes(id));
    if (!pending.length) return 0;

    const values: unknown[] = [];
    const rows = pending.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    for (const id of pending) {
      values.push(
        id,
        purchasedPackageId,
        serviceId,
        kind,
        title,
        body,
        new Date()
      );
    }
    await exec(
      `INSERT INTO package_notifications
         (id_user, id_purchased_package, id_purchased_package_service,
          kind, title, body, created)
       VALUES ${rows}`,
      values
    );
    return pending.length;
  } catch {
    // Migración pendiente: el aviso no se guarda, pero la acción sí termina.
    return 0;
  }
}

/**
 * Colapsa avisos repetidos que YA están en la base (los que pudo dejar una
 * versión anterior del panel o un doble envío antes de la idempotencia).
 *
 * Se consideran el mismo aviso los que tienen idéntico paquete, servicio,
 * tipo, título y cuerpo y se crearon con menos de [DEDUPE_WINDOW_MS] de
 * diferencia. Llegan ordenados del más nuevo al más viejo: se conserva el
 * primero y se descartan sus repetidos.
 */
function collapseRepeated(items: PackageNotification[]): PackageNotification[] {
  const out: PackageNotification[] = [];
  const lastOf = new Map<string, number>();
  for (const item of items) {
    const key = [
      item.kind,
      item.title,
      item.body,
      item.purchasedPackageId ?? "",
      item.serviceId ?? "",
    ].join("\u0001");
    const when = Date.parse(item.created.replace(" ", "T"));
    const prev = lastOf.get(key);
    const same =
      prev !== undefined &&
      Number.isFinite(when) &&
      Math.abs(prev - when) < DEDUPE_WINDOW_MS;
    if (same) continue;
    lastOf.set(key, Number.isFinite(when) ? when : 0);
    out.push(item);
  }
  return out;
}

/** Los avisos de UN usuario (más nuevos primero), con cuántos sin leer. */
export async function listUserNotifications(
  userId: number,
  limit = 60
): Promise<{ items: PackageNotification[]; unread: number }> {
  const take = Math.max(1, Math.min(100, Number(limit) || 60));
  try {
    const rows = await q<{
      id: number;
      kind: string;
      title: string;
      body: string;
      is_read: number;
      created: string;
      id_purchased_package: number | null;
      id_purchased_package_service: number | null;
      service_name: string | null;
    }>(
      `SELECT n.id, n.kind, n.title, n.body, n.is_read,
              DATE_FORMAT(n.created, '%Y-%m-%dT%H:%i:%s') AS created,
              n.id_purchased_package, n.id_purchased_package_service,
              s.name AS service_name
         FROM package_notifications n
         LEFT JOIN purchased_packages_services pps
                ON pps.id = n.id_purchased_package_service
         LEFT JOIN services s ON s.id = pps.id_service
        WHERE n.active = 1 AND n.id_user = ?
        ORDER BY n.id DESC
        LIMIT ${take}`,
      [userId]
    );
    const items = rows.map((r) => ({
      id: Number(r.id),
      kind: String(r.kind || "paquete"),
      title: String(r.title || ""),
      body: String(r.body || ""),
      isRead: Number(r.is_read) === 1,
      created: String(r.created || ""),
      purchasedPackageId:
        r.id_purchased_package === null
          ? null
          : Number(r.id_purchased_package),
      serviceId:
        r.id_purchased_package_service === null
          ? null
          : Number(r.id_purchased_package_service),
      serviceName: String(r.service_name || ""),
    }));
    // Una sola tarjeta por aviso, aunque la base tenga copias repetidas.
    const unique = collapseRepeated(items);
    return { items: unique, unread: unique.filter((i) => !i.isRead).length };
  } catch {
    return { items: [], unread: 0 };
  }
}

/** Marca leídos unos avisos (o TODOS si no se indican ids). */
export async function markNotificationsRead(
  userId: number,
  ids: number[] = []
): Promise<number> {
  const clean = ids.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
  try {
    if (clean.length) {
      const r = await exec(
        `UPDATE package_notifications
            SET is_read = 1
          WHERE id_user = ? AND active = 1 AND is_read = 0 AND id IN (?)`,
        [userId, clean]
      );
      return Number(r.affectedRows || 0);
    }
    const r = await exec(
      `UPDATE package_notifications
          SET is_read = 1
        WHERE id_user = ? AND active = 1 AND is_read = 0`,
      [userId]
    );
    return Number(r.affectedRows || 0);
  } catch {
    return 0;
  }
}
