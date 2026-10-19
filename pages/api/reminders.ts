import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../lib/cors";
import { requireUser } from "../../lib/auth";
import { q, exec } from "../../lib/db";
import { ensureRemindersForUser } from "../../lib/reminders";
import {
  listAdminNotifications,
  markAdminNotificationsRead,
} from "../../lib/admin-notifications";

// ==================================================================
// Avisos del usuario  ->  /api/reminders
//   GET            lista mis avisos (más recientes primero) + total sin leer
//   PUT { id }     marca UN aviso como leído
//   PUT { all:1 }  marca TODOS como leídos
//
// El usuario siempre es el de la sesión (nunca se confía en un id del
// cliente para elegir a quién pertenece un aviso).
//
// La lista mezcla DOS fuentes para que haya una sola campanita:
//   * `source: "event"`  recordatorios de agendas (falta 1 semana / 1 día).
//   * `source: "print"`  avisos del equipo: un cliente envió fotos a
//                        impresión (solo los reciben admins y colaboradores
//                        con permiso de Impresiones).
//
// Autogeneración perezosa: además del cron diario (que es quien genera
// los avisos por defecto), este GET crea los avisos vencidos del día si
// todavía no existen (por si el cron no está configurado o se atrasa).
// Así el panel muestra los recordatorios aunque solo se despliegue esto.
// ==================================================================

// "Ya generé los avisos de hoy de este usuario" (caché por proceso; el
// servidor de Vercel puede no persistir entre invocaciones, da igual: es
// solo para no repetir la consulta en cada refresco del panel).
const lastEnsure = new Map<number, number>();
const ENSURE_INTERVAL_MS = 60 * 60 * 1000; // 1 hora

type BellItem = Record<string, unknown>;

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  const session = await requireUser(req, res);
  if (!session) return;

  try {
    if (req.method === "GET") {
      const last = lastEnsure.get(session.sub) ?? 0;
      if (Date.now() - last > ENSURE_INTERVAL_MS) {
        lastEnsure.set(session.sub, Date.now());
        try {
          await ensureRemindersForUser(session.sub);
        } catch (e) {
          // No romper la lectura por la autogeneración.
          console.error("[reminders autogen]", e);
        }
      }

      // Los alias van en camelCase: es el CONTRATO que consume la app
      // (HsApi.reminders -> isRead/eventDate; la campanita cuenta isRead).
      const rows = await q<{
        id: number;
        scheduleId: number;
        kind: string;
        title: string;
        body: string;
        eventDate: string;
        isRead: number;
        created: string;
      }>(
        `SELECT r.id,
                r.id_schedule AS scheduleId,
                r.kind,
                r.title,
                r.body,
                DATE_FORMAT(r.event_date, '%Y-%m-%dT%H:%i:%s') AS eventDate,
                r.is_read AS isRead,
                DATE_FORMAT(r.created, '%Y-%m-%dT%H:%i:%s') AS created
           FROM reminders r
           JOIN schedules a ON a.id = r.id_schedule AND a.active = 1
          WHERE r.active = 1
            AND r.id_user = ?
            AND r.event_date >= DATE_SUB(NOW(), INTERVAL 1 DAY)
          ORDER BY r.event_date DESC, r.id DESC
          LIMIT 100`,
        [session.sub]
      );

      const items: BellItem[] = rows.map((r) => ({ ...r, source: "event" }));

      // Avisos del EQUIPO (envíos a impresión). Si la migración no está,
      // la lista llega vacía y no pasa nada.
      for (const n of await listAdminNotifications(session.sub)) {
        items.push({
          id: n.id,
          scheduleId: null,
          kind: n.kind,
          title: n.title,
          body: n.body,
          // La campanita pinta la fecha con `eventDate`: para estos avisos es
          // el momento en que se envió.
          eventDate: n.created,
          isRead: n.isRead ? 1 : 0,
          created: n.created,
          source: "print",
          printRequestId: n.printRequestId,
          serviceId: n.serviceId,
        });
      }

      // Más recientes primero (los dos orígenes ya vienen ordenados).
      items.sort((a, b) =>
        String(b.created ?? "").localeCompare(String(a.created ?? ""))
      );

      const unread = items.filter((i) => !Number(i.isRead)).length;
      res.status(200).json({ reminders: items, unread });
      return;
    }

    if (req.method === "PUT") {
      // La app manda Put { id, source } o { all: true }.
      const all = Boolean(req.body?.all);
      const id = Number(req.body?.id || 0);
      const source = String(req.body?.source || "event").toLowerCase();

      if (all) {
        await exec(
          `UPDATE reminders SET is_read = 1
            WHERE id_user = ? AND active = 1 AND is_read = 0`,
          [session.sub]
        );
        await markAdminNotificationsRead(session.sub);
      } else if (id > 0) {
        if (source === "print") {
          await markAdminNotificationsRead(session.sub, [id]);
        } else {
          await exec(
            `UPDATE reminders SET is_read = 1
              WHERE id = ? AND id_user = ? AND active = 1`,
            [id, session.sub]
          );
        }
      } else {
        res.status(400).json({ error: "Falta id o all" });
        return;
      }

      const rows = await q<{ unread: number }>(
        `SELECT COUNT(*) AS unread
           FROM reminders
          WHERE id_user = ? AND active = 1 AND is_read = 0`,
        [session.sub]
      );
      let unread = Number(rows[0]?.unread || 0);
      const printUnread = (await listAdminNotifications(session.sub, 100)).filter(
        (n) => !n.isRead
      );
      unread += printUnread.length;
      res.status(200).json({ ok: true, unread });
      return;
    }

    res.status(405).json({ error: "Método no permitido" });
  } catch (e) {
    console.error("[API reminders]", e);
    if (!res.headersSent) {
      res.status(500).json({ error: "Error interno del servidor" });
    }
  }
});
