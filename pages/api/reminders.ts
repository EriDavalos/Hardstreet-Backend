import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../lib/cors";
import { requireUser } from "../../lib/auth";
import { q, exec } from "../../lib/db";
import { ensureRemindersForUser } from "../../lib/reminders";

// ==================================================================
// Avisos del usuario  ->  /api/reminders
//   GET            lista mis avisos (más recientes primero) + total sin leer
//   PUT { id }     marca UN aviso como leído
//   PUT { all:1 }  marca TODOS como leídos
//
// El usuario siempre es el de la sesión (nunca se confía en un id del
// cliente para elegir a quién pertenece un aviso).
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

      const unread = rows.filter((r) => !Number(r.isRead)).length;
      res.status(200).json({ reminders: rows, unread });
      return;
    }

    if (req.method === "PUT") {
      // La app manda Put { id } o { all: true }.
      const all = Boolean(req.body?.all);
      const id = Number(req.body?.id || 0);

      if (all) {
        await exec(
          `UPDATE reminders SET is_read = 1
            WHERE id_user = ? AND active = 1 AND is_read = 0`,
          [session.sub]
        );
      } else if (id > 0) {
        await exec(
          `UPDATE reminders SET is_read = 1
            WHERE id = ? AND id_user = ? AND active = 1`,
          [id, session.sub]
        );
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
      res.status(200).json({ ok: true, unread: Number(rows[0]?.unread || 0) });
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
