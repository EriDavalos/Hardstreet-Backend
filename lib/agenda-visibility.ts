// ==================================================================
// HARD STREET BACKEND - Quién puede ver QUÉ de las agendas
// ==================================================================
// El calendario de Agendas es del ESTUDIO: ahí salen todos los eventos con
// su cliente, paquete, servicio, nota y lugar. Un CLIENTE también entra a
// ese calendario (rol "Cliente" o cualquier usuario con paquetes comprados),
// y lo que le interesa es saber CUÁNDO está el estudio ocupado y ver SUS
// propios eventos.
//
// Regla que se aplica aquí:
//
//   * Personal (Admin, o rol que puede CREAR/EDITAR/BORRAR agendas) -> todo.
//   * Cliente -> sus eventos completos (los de SUS paquetes) y los demás
//     como simples huecos OCUPADOS: sin cliente, sin paquete, sin servicio,
//     sin nota y sin lugar.
//
// El enmascarado se hace en el SERVIDOR: la app solo recibe lo que puede
// ver, así que no hay forma de sacar los datos de otro cliente mirando la
// respuesta (ni desde el panel, ni desde el widget, ni con curl).
//
// OJO: este módulo NO decide permisos (eso es permissions.ts). Solo decide
// cuánto detalle se devuelve.
// ==================================================================

import { q } from "./db";
import { roleCan, userIsAdmin, userRoleId } from "./permissions";

/** Nombre del rol fijo de los clientes (roles.name). */
export const CLIENT_ROLE = "cliente";

/** Una ubicación de la agenda: número (1, 2, 3…) + nombre y coordenadas. */
export type AgendaLocation = {
  id?: number;
  /** Número con el que se enumera la ubicación (1 = primera). */
  position: number;
  location: string;
  lat: number | null;
  lng: number | null;
};

/** Una agenda tal como la manda la API (camelCase). */
export interface AgendaItem {
  id: number;
  purchasedPackageId: number | null;
  userId: number | null;
  clientName: string;
  packageName: string;
  serviceId: number | null;
  serviceName: string;
  eventDate: string;
  description: string;
  /** Primera ubicación (compatibilidad con el calendario y el widget). */
  location: string;
  lat: number | null;
  lng: number | null;
  /** TODAS las ubicaciones, ya numeradas por `position` (1, 2, 3…). */
  locations?: AgendaLocation[];
  /** true = hueco ocupado SIN detalle (solo lo reciben los clientes). */
  busy: boolean;
}

/** Rol del usuario (id + nombre), leído de la BD (no del token). */
export async function viewerRole(
  userId: number
): Promise<{ id: number | null; name: string }> {
  try {
    const rows = await q<{ id_role: number | null; role_name: string | null }>(
      `SELECT u.id_role, r.name AS role_name
         FROM users u
         LEFT JOIN roles r ON r.id = u.id_role
        WHERE u.id = ?
        LIMIT 1`,
      [userId]
    );
    const row = rows[0];
    return {
      id: row?.id_role ?? null,
      name: String(row?.role_name || ""),
    };
  } catch {
    return { id: null, name: "" };
  }
}

/** Ids de los paquetes comprados ACTIVOS de los que el usuario es cliente. */
export async function clientPackageIds(userId: number): Promise<number[]> {
  if (!userId) return [];
  try {
    const rows = await q<{ id: number }>(
      `SELECT DISTINCT id_purchased_package AS id
         FROM users_packages
        WHERE id_user = ? AND active = 1`,
      [userId]
    );
    return rows
      .map((r) => Number(r.id))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * ¿Quien consulta es un CLIENTE (y por lo tanto ve los demás eventos como
 * "ocupado")?
 *
 *   * Admin -> NO (ve todo).
 *   * Rol con permiso para CREAR, EDITAR o BORRAR agendas -> NO: es personal
 *     del estudio aunque además tenga un paquete comprado.
 *   * Rol "Cliente" (aunque todavía no tenga paquetes) -> SÍ.
 *   * Cualquier otro usuario con paquetes comprados -> SÍ (es cliente de
 *     hecho, igual que en el Drive).
 */
export async function viewerIsClient(userId: number): Promise<boolean> {
  if (!userId) return false;
  const roleId = await userRoleId(userId);
  if (roleId && (await userIsAdmin(roleId))) return false;

  if (roleId) {
    // Personal: puede administrar el calendario. Aunque tenga un paquete
    // comprado a su nombre, sigue viendo la agenda completa.
    for (const action of ["create", "update", "delete"] as const) {
      if (await roleCan(roleId, "schedules", action)) return false;
    }
  }

  const role = await viewerRole(userId);
  if (role.name.trim().toLowerCase() === CLIENT_ROLE) return true;

  return (await clientPackageIds(userId)).length > 0;
}

/** Copia de la agenda SIN detalle: solo el hueco y la hora. */
export function busyAgenda(item: AgendaItem): AgendaItem {
  return {
    id: item.id,
    purchasedPackageId: null,
    userId: null,
    clientName: "",
    packageName: "",
    serviceId: null,
    serviceName: "",
    eventDate: item.eventDate,
    description: "",
    location: "",
    lat: null,
    lng: null,
    locations: [],
    busy: true,
  };
}

/**
 * Qué versión de [item] recibe quien consulta:
 *   * personal -> la agenda completa (`busy: false`);
 *   * cliente y es SUYA (paquete propio, o agenda suelta a su nombre) ->
 *     completa;
 *   * cliente y es de OTRO -> hueco ocupado, sin nombres ni detalles.
 *
 * [viewerId] es el usuario de la sesión: con él se reconocen las agendas que
 * el estudio le agendó SIN paquete (solo el cliente, migración 2026-10-22).
 */
export function agendaForViewer(
  item: AgendaItem,
  isClient: boolean,
  ownPackageIds: Set<number> | null,
  viewerId: number | null = null
): AgendaItem {
  if (!isClient) return { ...item, busy: false };
  const own = item.purchasedPackageId;
  if (own !== null && ownPackageIds?.has(Number(own))) {
    return { ...item, busy: false };
  }
  // Agenda del CLIENTE sin paquete: es suya aunque no tenga paquetes.
  if (item.userId !== null && viewerId !== null && Number(item.userId) === viewerId) {
    return { ...item, busy: false };
  }
  return busyAgenda(item);
}
