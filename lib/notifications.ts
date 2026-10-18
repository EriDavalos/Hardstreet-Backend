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
    const values: unknown[] = [];
    const rows = ids.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    for (const id of ids) {
      values.push(
        id,
        purchasedPackageId,
        serviceId,
        kindOf(input.kind),
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
    return ids.length;
  } catch {
    // Migración pendiente: el aviso no se guarda, pero la acción sí termina.
    return 0;
  }
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
    return { items, unread: items.filter((i) => !i.isRead).length };
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
