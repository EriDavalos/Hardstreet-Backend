import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import {
  cleanupOldReminders,
  ensureRemindersForToday,
} from "../../../lib/reminders";

// ==================================================================
// Cron diario de avisos  ->  /api/cron/reminders
// Genera los avisos de los eventos que faltan 7 días y 1 día, y
// desactiva los avisos de eventos que ya pasaron.
//
// PROTEGIDO: Vercel envía `Authorization: Bearer ${CRON_SECRET}` cuando
// CRON_SECRET está definida en las variables de entorno del proyecto.
// Para probarlo a mano también acepta `?secret=<CRON_SECRET>`.
//
// Horario (vercel.json): 0 14 * * * UTC = 08:00 en México (UTC-6).
// La fecha "hoy" se calcula en la zona del negocio (APP_TZ), no con el
// reloj del servidor, para que "mañana" siempre coincida con el cliente.
// ==================================================================

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido" });
    return;
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    res.status(500).json({
      error:
        "Falta CRON_SECRET en las variables de entorno (Vercel → Settings → Environment Variables)",
    });
    return;
  }

  const auth = String(req.headers.authorization || "");
  const provided = (auth.startsWith("Bearer ") ? auth.slice(7).trim() : "") ||
    String(req.query.secret || "");
  if (provided !== secret) {
    res.status(401).json({ error: "CRON_SECRET inválido" });
    return;
  }

  try {
    const { created, targets } = await ensureRemindersForToday();
    const cleaned = await cleanupOldReminders();
    res.status(200).json({ ok: true, created, cleaned, targets });
  } catch (e) {
    console.error("[cron reminders]", e);
    if (!res.headersSent) {
      res.status(500).json({ error: "Error interno del servidor" });
    }
  }
});
