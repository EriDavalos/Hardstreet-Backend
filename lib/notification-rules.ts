// ==================================================================
// HARD STREET BACKEND - REGLAS DE NOTIFICACIONES (evento -> roles)
// ==================================================================
// El módulo «Notificaciones» del panel deja elegir, PARA CADA EVENTO, qué
// roles reciben el aviso. La configuración vive en `notification_rules`
// (una fila por evento + rol + empresa; migración
// 2026-10-20_notificaciones_ubicaciones.sql).
//
// Eventos automáticos que ya emite el sistema:
//
//   * `agenda-proxima`     falta 1 semana / falta 1 día (lib/reminders.ts)
//   * `fotos-disponibles`  el estudio abre la selección de fotos
//                          (lib/notifications.ts)
//   * `fotos-enviadas`     el cliente manda sus fotos a impresión
//                          (lib/admin-notifications.ts)
//   * `servicio-terminado` se cierra un servicio del paquete
//   * `paquete-terminado`  se cierra el paquete completo
//   * `pago-recibido`      abono/pago registrado en el paquete
//
// SIN una regla guardada se usan los roles POR DEFECTO del evento: la
// configuración es opcional y el panel sigue funcionando igual que antes.
// Si la tabla todavía no existe, todo cae a esos valores por defecto.
// ==================================================================

import { q, exec } from "./db";


export type NotificationEvent = {
  key: string;
  title: string;
  description: string;
  /** Módulo al que lleva el aviso cuando se toca en la campanita. */
  target: string;
  /** Roles que lo reciben mientras nadie los cambie en el módulo. */
  defaultRoles: string[];
  /** true = el sistema lo dispara solo; false = solo avisos manuales. */
  automatic: boolean;
};

/**
 * Catálogo de eventos. El orden es el que se ve en el módulo.
 * `target` usa la CLAVE del módulo (`modules.module`): la app la traduce a su
 * pantalla (Impresiones, Mi paquete, Agendas, Clientes…).
 */
export const NOTIFICATION_EVENTS: NotificationEvent[] = [
  {
    key: "agenda-proxima",
    title: "Avisar a fechas próximas a agenda",
    description:
      "Falta una semana y falta un día de cada evento agendado. A los " +
      "clientes se les avisa solo de SUS eventos.",
    target: "schedules",
    defaultRoles: ["Cliente", "Colaborador"],
    automatic: true,
  },
  {
    key: "fotos-disponibles",
    title: "Avisar cuando se puedan seleccionar las fotos",
    description:
      "Cuando el estudio abre «Elegir fotos» de un servicio y toca " +
      "«Avisar al cliente».",
    target: "my_package",
    defaultRoles: ["Cliente"],
    automatic: true,
  },
  {
    key: "fotos-enviadas",
    title: "Avisar el envío de fotos seleccionadas",
    description:
      "Cuando el cliente manda a impresión las fotos que eligió. Es el " +
      "aviso que abre el trabajo al equipo.",
    target: "print",
    defaultRoles: ["Colaborador"],
    automatic: true,
  },
  {
    key: "servicio-terminado",
    title: "Avisar cuando se termina un servicio",
    description:
      "Cuando el estudio marca como terminado un servicio del paquete.",
    target: "my_package",
    defaultRoles: ["Cliente"],
    automatic: true,
  },
  {
    key: "paquete-terminado",
    title: "Avisar cuando se termina el paquete",
    description: "Cuando se da por cerrado el paquete completo del cliente.",
    target: "my_package",
    defaultRoles: ["Cliente"],
    automatic: true,
  },
  {
    key: "impresion-terminada",
    title: "Avisar cuando la impresión está lista",
    description:
      "Cuando el estudio cierra el envío de impresión: las fotos del " +
      "cliente ya están listas.",
    target: "my_package",
    defaultRoles: ["Cliente"],
    automatic: true,
  },
  {
    key: "aviso-manual",
    title: "Avisos manuales del estudio",
    description:
      "Los avisos que escribes a mano desde este módulo. Elige aquí quién " +
      "los recibe por defecto.",
    target: "notifications",
    defaultRoles: [],
    automatic: false,
  },
];

export const eventOf = (key: string): NotificationEvent | undefined =>
  NOTIFICATION_EVENTS.find((e) => e.key === key);

const norm = (v: unknown) =>
  String(v ?? "")
    .trim()
    .toLowerCase();

type RuleRow = {
  event_key: string;
  id_role: number | null;
  enabled: number | null;
};

export type EventRule = {
  /** ¿Hay una regla guardada para el evento? (si no, se usan los defaults) */
  configured: boolean;
  enabled: boolean;
  roleIds: number[];
  roles: string[];
};

/** Rol y empresa de un usuario (para aplicar la regla de SU empresa). */
export async function userRoleInfo(userId: number): Promise<{
  roleId: number;
  roleName: string;
  companyId: number | null;
}> {
  const empty = { roleId: 0, roleName: "", companyId: null };
  try {
    const rows = await q<{
      id_role: number | null;
      role_name: string | null;
      id_company: number | null;
    }>(
      `SELECT u.id_role, r.name AS role_name, u.id_company
         FROM users u
         LEFT JOIN roles r ON r.id = u.id_role
        WHERE u.id = ? AND u.active = 1
        LIMIT 1`,
      [userId]
    );
    const row = rows[0];
    if (!row) return empty;
    return {
      roleId: Number(row.id_role || 0),
      roleName: String(row.role_name || ""),
      companyId: row.id_company === null ? null : Number(row.id_company),
    };
  } catch {
    // Sin la migración de Empresas: se resuelve sin empresa.
    try {
      const rows = await q<{ id_role: number | null; role_name: string | null }>(
        `SELECT u.id_role, r.name AS role_name
           FROM users u
           LEFT JOIN roles r ON r.id = u.id_role
          WHERE u.id = ? AND u.active = 1
          LIMIT 1`,
        [userId]
      );
      const row = rows[0];
      if (!row) return empty;
      return {
        roleId: Number(row.id_role || 0),
        roleName: String(row.role_name || ""),
        companyId: null,
      };
    } catch {
      return empty;
    }
  }
}

/** Nombres de rol activos, con su id (para el módulo). */
export async function roleCatalog(): Promise<{ id: number; name: string }[]> {
  try {
    const rows = await q<{ id: number; name: string | null }>(
      `SELECT id, name FROM roles WHERE active = 1 ORDER BY id`
    );
    return rows
      .map((r) => ({ id: Number(r.id), name: String(r.name || "").trim() }))
      .filter((r) => r.id > 0 && r.name !== "");
  } catch {
    return [];
  }
}

/** Reglas guardadas de una empresa (o de todas si [companyId] es null). */
async function storedRules(companyId: number | null): Promise<RuleRow[]> {
  try {
    return await q<RuleRow>(
      `SELECT event_key, id_role, enabled
         FROM notification_rules
        WHERE active = 1
          ${companyId === null ? "" : "AND id_company = ?"}`,
      companyId === null ? [] : [companyId]
    );
  } catch {
    // Tabla pendiente: sin configuración guardada.
    return [];
  }
}

/**
 * Regla efectiva de UN evento: la guardada de la empresa o, si no hay,
 * los roles por defecto del catálogo.
 */
export async function ruleFor(
  companyId: number | null,
  eventKey: string
): Promise<EventRule> {
  const event = eventOf(eventKey);
  const roles = await roleCatalog();
  const byName = new Map(roles.map((r) => [norm(r.name), r]));
  const byId = new Map(roles.map((r) => [r.id, r.name]));

  const rows = (await storedRules(companyId)).filter(
    (r) => String(r.event_key || "") === eventKey
  );

  if (!rows.length) {
    const roleIds = (event?.defaultRoles ?? [])
      .map((name) => byName.get(norm(name))?.id ?? 0)
      .filter((n) => n > 0);
    return {
      configured: false,
      enabled: true,
      roleIds,
      roles: roleIds.map((id) => byId.get(id) ?? "").filter(Boolean),
    };
  }

  const enabled = rows.some((r) => Number(r.enabled) === 1);
  const roleIds = enabled
    ? rows
        .filter((r) => Number(r.enabled) === 1)
        .map((r) => Number(r.id_role || 0))
        .filter((n) => n > 0 && byId.has(n))
    : [];
  return {
    configured: true,
    enabled,
    roleIds: [...new Set(roleIds)],
    roles: [...new Set(roleIds.map((id) => byId.get(id) ?? ""))].filter(Boolean),
  };
}

/** Nombres de los roles que reciben el evento ([] = a nadie). */
export async function recipientRoles(
  companyId: number | null,
  eventKey: string
): Promise<string[]> {
  const rule = await ruleFor(companyId, eventKey);
  return rule.enabled ? rule.roles : [];
}

/** ¿Este evento ya tiene una regla guardada? (ver [ruleFor]) */
export async function ruleIsConfigured(
  companyId: number | null,
  eventKey: string
): Promise<boolean> {
  return (await ruleFor(companyId, eventKey)).configured;
}

/**
 * Guarda la regla de un evento: REEMPLAZA sus filas por los roles elegidos.
 * `enabled = false` deja constancia de que el evento está apagado (una fila
 * centinela con `id_role = 0`), para no confundirlo con «sin configurar».
 */
export async function saveRule(
  companyId: number,
  eventKey: string,
  roleIds: number[],
  enabled: boolean
): Promise<EventRule> {
  const key = String(eventKey || "").trim();
  if (!eventOf(key)) {
    throw Object.assign(new Error("Ese aviso no existe"), { status: 400 });
  }
  const company = Number(companyId) || 0;
  if (!company) {
    throw Object.assign(new Error("No se pudo identificar la empresa"), {
      status: 400,
    });
  }
  const roles = [...new Set(roleIds.map((n) => Number(n)).filter((n) => n > 0))];
  const ids = enabled && roles.length ? roles : [0];

  await exec(
    `DELETE FROM notification_rules
      WHERE id_company = ? AND event_key = ?`,
    [company, key]
  );
  for (const idRole of ids) {
    await exec(
      `INSERT INTO notification_rules
         (id_company, event_key, id_role, enabled, active)
       VALUES (?, ?, ?, ?, 1)`,
      [company, key, idRole, enabled ? 1 : 0]
    );
  }
  return ruleFor(company, key);
}

/** Usuarios activos con esos roles (y de esa empresa, si se indica). */
export async function usersWithRoles(
  roleNames: string[],
  companyId: number | null = null
): Promise<number[]> {
  const names = [
    ...new Set(roleNames.map(norm).filter((n) => n.length > 0)),
  ];
  if (!names.length) return [];
  const holes = names.map(() => "?").join(", ");
  const params: unknown[] = [...names];
  let companyCond = "";
  if (companyId) {
    companyCond = "AND (u.id_company = ? OR u.id_company IS NULL)";
    params.push(companyId);
  }
  try {
    const rows = await q<{ id: number }>(
      `SELECT DISTINCT u.id
         FROM users u
         JOIN roles r ON r.id = u.id_role AND r.active = 1
        WHERE u.active = 1
          AND LOWER(r.name) IN (${holes})
          ${companyCond}`,
      params
    );
    return rows.map((r) => Number(r.id)).filter((n) => n > 0);
  } catch {
    return [];
  }
}

/** Ids de los usuarios que deben recibir un evento según su regla. */
export async function recipientsOf(
  companyId: number | null,
  eventKey: string,
  extraRoleNames: string[] = []
): Promise<number[]> {
  const rule = await ruleFor(companyId, eventKey);
  if (!rule.enabled) return [];
  return usersWithRoles([...rule.roles, ...extraRoleNames], companyId);
}

/**
 * Manda un aviso a los roles indicados (una fila por usuario en
 * `admin_notifications`, la misma bandeja que la campanita del panel).
 * Devuelve cuántos avisos se crearon.
 */
export async function notifyRoles(input: {
  companyId?: number | null;
  roles: string[];
  title: string;
  body?: string;
  target?: string;
  kind?: string;
}): Promise<number> {
  const title = String(input.title ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  if (!title) return 0;
  const body = String(input.body ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  const kind = String(input.kind || "manual").slice(0, 40) || "manual";
  const target = String(input.target || "").trim().slice(0, 40) || null;
  const companyId = Number(input.companyId || 0) || null;
  const recipients = await usersWithRoles(input.roles, companyId);
  if (!recipients.length) return 0;

  const rows = recipients.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
  const values: unknown[] = [];
  for (const id of recipients) {
    values.push(id, kind, title, body, target, companyId);
  }
  try {
    await exec(
      `INSERT INTO admin_notifications
         (id_user, kind, title, body, target, id_company)
       VALUES ${rows}`,
      values
    );
    return recipients.length;
  } catch {
    // Migración pendiente (sin `target`/`id_company`): se guarda sin ellos.
    const legacy = recipients.map(() => "(?, ?, ?, ?)").join(", ");
    const legacyValues: unknown[] = [];
    for (const id of recipients) {
      legacyValues.push(id, kind, title, body);
    }
    try {
      await exec(
        `INSERT INTO admin_notifications
           (id_user, kind, title, body)
         VALUES ${legacy}`,
        legacyValues
      );
    } catch {
      return 0;
    }
  }
  return recipients.length;
}

export type SentNotification = {
  id: number;
  kind: string;
  title: string;
  body: string;
  target: string;
  isRead: boolean;
  created: string;
  userName: string;
  roleName: string;
};

/** Historial de avisos enviados (los más recientes primero). */
export async function sentHistory(
  companyId: number | null,
  limit = 40
): Promise<SentNotification[]> {
  const take = Math.max(1, Math.min(100, Number(limit) || 40));
  try {
    const rows = await q<{
      id: number;
      kind: string;
      title: string;
      body: string;
      target: string | null;
      is_read: number;
      created: string;
      user_name: string | null;
      role_name: string | null;
    }>(
      `SELECT n.id, n.kind, n.title, n.body, n.target, n.is_read,
              DATE_FORMAT(n.created, '%Y-%m-%dT%H:%i:%s') AS created,
              TRIM(CONCAT(COALESCE(u.name, ''), ' ', COALESCE(u.lastname, '')))
                AS user_name,
              r.name AS role_name
         FROM admin_notifications n
         LEFT JOIN users u ON u.id = n.id_user
         LEFT JOIN roles r ON r.id = u.id_role
        WHERE n.active = 1
          ${companyId === null ? "" : "AND (n.id_company = ? OR n.id_company IS NULL)"}
        ORDER BY n.id DESC
        LIMIT ${take}`,
      companyId === null ? [] : [companyId]
    );
    return rows.map((r) => ({
      id: Number(r.id),
      kind: String(r.kind || ""),
      title: String(r.title || ""),
      body: String(r.body || ""),
      target: String(r.target || ""),
      isRead: Number(r.is_read) === 1,
      created: String(r.created || ""),
      userName: String(r.user_name || "").trim(),
      roleName: String(r.role_name || ""),
    }));
  } catch {
    return [];
  }
}
