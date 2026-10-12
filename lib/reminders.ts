// ==================================================================
// HARD STREET BACKEND - Avisos de eventos (recordatorios)
// ==================================================================
// Genera avisos "falta 1 semana" (kind '7d') y "falta 1 día" (kind '1d')
// para cada evento de `schedules`, dirigidos a los usuarios que ven el
// módulo Agendas (rol Admin o permiso activo sobre el módulo).
//
// Quién genera los avisos (dos vías, complementarias):
//   1. El cron diario de Vercel  -> pages/api/cron/reminders.ts
//   2. La propia app al consultar /api/reminders (autogeneración perezosa,
//      por si el cron no está configurado o se atrasa).
//
// Idempotente: la tabla `reminders` tiene llave única (id_user,
// id_schedule, kind) y el INSERT usa IGNORE, así que repetir no duplica.
// ==================================================================

import { q, exec } from "./db";

/** Cuentas regresivas configuradas. 7 = falta una semana; 1 = mañana. */
export const REMINDER_DAYS = [7, 1] as const;
export type ReminderKind = "7d" | "1d";

/**
 * Zona horaria del negocio para los cálculos de "hoy"/"mañana".
 * Se fija explícitamente para no depender del reloj del servidor MySQL.
 */
const APP_TZ = process.env.APP_TZ || "America/Mexico_City";

/** "Hoy" (YYYY-MM-DD) en la zona horaria del negocio. */
export function todayInTz(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Suma días a una fecha "YYYY-MM-DD" (a mediodía UTC, inmune a DST). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface DueSchedule {
  id: number;
  event_date: string; // YYYY-MM-DDTHH:MM:SS
  description: string | null;
  package_name: string | null;
  service_name: string | null;
  client_name: string | null;
}

/** Usuarios que reciben avisos: Admin o con permiso activo sobre Agendas. */
export async function eligibleUserIds(): Promise<number[]> {
  const rows = await q<{ id: number }>(
    `SELECT DISTINCT u.id
       FROM users u
       JOIN roles r ON r.id = u.id_role AND r.active = 1
      WHERE u.active = 1
        AND (
          LOWER(r.name) = 'admin'
          OR EXISTS (
            SELECT 1
              FROM permissions_roles pr
              JOIN modules m ON m.id = pr.id_modules AND m.active = 1
             WHERE pr.active = 1
               AND pr.id_role = r.id
               AND (LOWER(m.\`module\`) IN ('schedules', 'agendas')
                    OR LOWER(m.name)    IN ('schedules', 'agendas'))
          )
        )`
  );
  return rows.map((r) => r.id);
}

/** ¿Este usuario en particular es elegible? (misma regla, un solo usuario) */
export async function userIsEligible(userId: number): Promise<boolean> {
  const rows = await q<{ ok: number }>(
    `SELECT 1 AS ok
       FROM users u
       JOIN roles r ON r.id = u.id_role AND r.active = 1
      WHERE u.active = 1
        AND u.id = ?
        AND (
          LOWER(r.name) = 'admin'
          OR EXISTS (
            SELECT 1
              FROM permissions_roles pr
              JOIN modules m ON m.id = pr.id_modules AND m.active = 1
             WHERE pr.active = 1
               AND pr.id_role = r.id
               AND (LOWER(m.\`module\`) IN ('schedules', 'agendas')
                    OR LOWER(m.name)    IN ('schedules', 'agendas'))
          )
        )
      LIMIT 1`,
    [userId]
  );
  return rows.length > 0;
}

/** Eventos activos de un día concreto ("YYYY-MM-DD"), con cliente/paquete. */
export async function dueSchedules(date: string): Promise<DueSchedule[]> {
  // Rango abierto (>= y <) para poder usar el índice de event_date.
  const from = `${date} 00:00:00`;
  const to = `${addDays(date, 1)} 00:00:00`;
  return q<DueSchedule>(
    `SELECT a.id,
            DATE_FORMAT(a.event_date, '%Y-%m-%dT%H:%i:%s') AS event_date,
            a.description,
            pp.name AS package_name,
            s.name AS service_name,
            (SELECT TRIM(CONCAT(u2.name, ' ', COALESCE(u2.lastname, '')))
               FROM users_packages up2
               JOIN users u2 ON u2.id = up2.id_user
              WHERE up2.id_purchased_package = a.id_purchased_package
                AND up2.active = 1 AND u2.active = 1
              ORDER BY up2.id LIMIT 1) AS client_name
       FROM schedules a
       LEFT JOIN purchased_packages pp ON pp.id = a.id_purchased_package
       LEFT JOIN services s ON s.id = a.id_service
      WHERE a.active = 1
        AND a.event_date >= ?
        AND a.event_date < ?
      ORDER BY a.event_date ASC, a.id ASC`,
    [from, to]
  );
}

/** Texto del aviso: "En una semana: <label>" / "Mañana: <label>". */
export function buildReminder(
  ev: DueSchedule,
  kind: ReminderKind
): { title: string; body: string } {
  const parts = [ev.description, ev.service_name, ev.package_name]
    .map((v) => (v || "").trim())
    .filter(Boolean);
  const label = (parts.join(" — ") || `Evento #${ev.id}`).slice(0, 160);

  // "YYYY-MM-DDTHH:MM:SS" -> "DD/MM/YYYY HH:MM"
  const stamp = (ev.event_date || "").replace("T", " ");
  const date = stamp.slice(0, 10);
  const time = stamp.length >= 16 ? ` ${stamp.slice(11, 16)}` : "";
  const fecha = `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}${time}`;

  const title = (kind === "7d" ? `En una semana: ${label}` : `Mañana: ${label}`)
    .slice(0, 200);
  const body = (ev.client_name
    ? `${fecha} · Cliente: ${ev.client_name.trim()}`
    : fecha
  ).slice(0, 500);
  return { title, body };
}

/** Crea los avisos (idempotente). Devuelve los filas realmente nuevas. */
export async function createReminders(
  userIds: number[],
  ev: DueSchedule,
  kind: ReminderKind
): Promise<number> {
  if (!userIds.length) return 0;
  const { title, body } = buildReminder(ev, kind);
  const rows = userIds.map((uid) => [uid, ev.id, kind, title, body, ev.event_date]);
  const res = await exec(
    `INSERT IGNORE INTO reminders
       (id_user, id_schedule, kind, title, body, event_date)
     VALUES ?`,
    [rows as unknown as unknown[]]
  );
  return res.affectedRows;
}

/**
 * Genera TODOS los avisos vencidos de hoy (para todos los usuarios).
 * Hoy T -> eventos de T+7 (falta 1 semana) y T+1 (mañana).
 */
export async function ensureRemindersForToday(
  now: Date = new Date()
): Promise<{ created: number; targets: Record<string, string> }> {
  const today = todayInTz(now);
  const users = await eligibleUserIds();
  let created = 0;
  const targets: Record<string, string> = {};
  for (const days of REMINDER_DAYS) {
    const target = addDays(today, days);
    targets[`${days}d`] = target;
    for (const ev of await dueSchedules(target)) {
      created += await createReminders(users, ev, `${days}d` as ReminderKind);
    }
  }
  return { created, targets };
}

/**
 * Autogeneración perezosa para UN usuario (la usa GET /api/reminders):
 * si el cron no corrió, el panel crea igual los avisos vencidos de hoy.
 */
export async function ensureRemindersForUser(userId: number): Promise<number> {
  if (!(await userIsEligible(userId))) return 0;
  const today = todayInTz();
  let created = 0;
  for (const days of REMINDER_DAYS) {
    for (const ev of await dueSchedules(addDays(today, days))) {
      created += await createReminders([userId], ev, `${days}d` as ReminderKind);
    }
  }
  return created;
}

/** Desactiva avisos de eventos que ya pasaron (limpieza del cron). */
export async function cleanupOldReminders(): Promise<number> {
  const res = await exec(
    `UPDATE reminders
        SET active = 0
      WHERE active = 1
        AND event_date < DATE_SUB(NOW(), INTERVAL 1 DAY)`
  );
  return res.affectedRows;
}
