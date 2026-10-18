import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requireUser } from "../../../lib/auth";
import {
  listUserNotifications,
  markNotificationsRead,
} from "../../../lib/notifications";

// ==================================================================
// AVISOS DEL PAQUETE DEL CLIENTE -> /api/my/notifications
//
//   GET  { notifications: [{ id, kind, title, body, isRead, created, … }],
//          unread }
//   POST { id } | { ids: [..] } | { all: true }  -> marca leídos
//
// El usuario SIEMPRE es el de la sesión: no se acepta un id de usuario del
// cuerpo. Sin la migración de notificaciones devuelve una lista vacía.
// ==================================================================

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  const session = await requireUser(req, res);
  if (!session) return;

  try {
    if (req.method === "GET") {
      const { items, unread } = await listUserNotifications(session.sub);
      res.status(200).json({ notifications: items, unread });
      return;
    }

    if (req.method === "POST" || req.method === "PUT") {
      const body = (req.body || {}) as Record<string, unknown>;
      const rawIds = Array.isArray(body.ids)
        ? body.ids
        : body.id !== undefined
        ? [body.id]
        : [];
      const ids = rawIds.map((v) => Number(v)).filter((n) => n > 0);
      const all = body.all === true || body.all === 1 || ids.length === 0;
      const changed = await markNotificationsRead(
        session.sub,
        all ? [] : ids
      );
      const after = await listUserNotifications(session.sub);
      res.status(200).json({ ok: true, changed, unread: after.unread });
      return;
    }

    res.status(405).json({ error: "Método no permitido" });
  } catch (e) {
    console.error("[my/notifications]", e);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});
