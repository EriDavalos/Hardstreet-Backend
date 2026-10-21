import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { ok, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";
import { requestScope } from "../../../lib/company-scope";
import {
  NOTIFICATION_EVENTS,
  notifyRoles,
  roleCatalog,
  ruleFor,
  saveRule,
  sentHistory,
} from "../../../lib/notification-rules";

// ==================================================================
// MÓDULO NOTIFICACIONES -> /api/admin/notifications
//
//   GET
//     { events: [{ key, title, description, target, automatic,
//                  configured, enabled, roleIds, roles: ["Cliente", …],
//                  defaultRoles: ["Cliente", …] }],
//       roles: [{ id, name }],
//       history: [{ id, kind, title, body, target, isRead, created,
//                   userName, roleName }] }
//
//   POST { action: "save-rule", eventKey, roleIds: [1, 2], enabled }
//        Guarda QUÉ ROLES reciben ese aviso (y si está encendido).
//   POST { action: "send", title, body, roleIds: [..], target }
//        Manda un aviso manual a los roles elegidos; llega a la campanita
//        de cada usuario y, al tocarlo, abre el módulo `target`.
//
// Permiso: módulo "notifications" (Ver para GET; Crear/Editar para las
// acciones). El Superadmin y el rol Admin pasan siempre.
// ==================================================================

/** Empresa con la que se trabaja: el Superadmin sin empresa usa la principal. */
function companyOf(scope: { companyId: number | null; writeCompanyId: number }) {
  return scope.companyId ?? scope.writeCompanyId;
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method === "GET") {
    const session = await requirePermission(req, res, "notifications", "read");
    if (!session) return;
    try {
      const scope = await requestScope(req, session);
      const companyId = companyOf(scope);
      const [roles, history] = await Promise.all([
        roleCatalog(),
        sentHistory(companyId),
      ]);
      const events = [];
      for (const event of NOTIFICATION_EVENTS) {
        const rule = await ruleFor(companyId, event.key);
        events.push({
          key: event.key,
          title: event.title,
          description: event.description,
          target: event.target,
          automatic: event.automatic,
          defaultRoles: event.defaultRoles,
          configured: rule.configured,
          enabled: rule.enabled,
          roleIds: rule.roleIds,
          roles: rule.roles,
        });
      }
      ok(res, "Notificaciones", {
        events,
        roles,
        history,
        companyId,
      });
    } catch (e) {
      console.error("[admin/notifications] GET:", e);
      fail(res, 500, "No se pudieron cargar las notificaciones");
    }
    return;
  }

  if (req.method !== "POST") {
    fail(res, 405, "Método no permitido");
    return;
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const action = String(body.action || "").trim().toLowerCase();

  if (action === "save-rule") {
    const session = await requirePermission(req, res, "notifications", "update");
    if (!session) return;
    const scope = await requestScope(req, session);
    const companyId = companyOf(scope);
    const eventKey = String(body.eventKey || "").trim();
    const roleIds = Array.isArray(body.roleIds)
      ? body.roleIds.map((v) => Number(v)).filter((n) => n > 0)
      : [];
    const enabled = body.enabled !== false && body.enabled !== 0;
    try {
      const rule = await saveRule(companyId, eventKey, roleIds, enabled);
      await logActivity({
        userId: session.sub,
        module: "notifications",
        moduleName: "Notificaciones",
        action: "update",
        entity: "notificacion",
        description:
          `Configuró el aviso «${eventKey}»` +
          (enabled
            ? rule.roles.length
              ? ` para ${rule.roles.join(", ")}`
              : " sin destinatarios"
            : " (apagado)"),
        companyId,
      });
      ok(res, enabled ? "Aviso actualizado" : "Aviso apagado", {
        item: rule,
        eventKey,
      });
    } catch (e) {
      console.error("[admin/notifications] save-rule:", e);
      const status = Number((e as any)?.status) || 500;
      fail(
        res,
        status,
        (e as Error)?.message || "No se pudo guardar el aviso"
      );
    }
    return;
  }

  if (action === "send") {
    const session = await requirePermission(req, res, "notifications", "create");
    if (!session) return;
    const scope = await requestScope(req, session);
    const companyId = companyOf(scope);
    const title = String(body.title || "").replace(/\s+/g, " ").trim();
    if (!title) {
      fail(res, 400, "Escribe el aviso", "El aviso necesita un título");
      return;
    }
    try {
      let roleIds = Array.isArray(body.roleIds)
        ? body.roleIds.map((v) => Number(v)).filter((n) => n > 0)
        : [];
      if (!roleIds.length) {
        roleIds = (await ruleFor(companyId, "aviso-manual")).roleIds;
      }
      if (!roleIds.length) {
        fail(
          res,
          400,
          "Elige quién lo recibe",
          "Marca al menos un rol destinatario"
        );
        return;
      }
      const roles = (await roleCatalog())
        .filter((r) => roleIds.includes(r.id))
        .map((r) => r.name);
      const target = String(body.target || "notifications").trim();
      const sent = await notifyRoles({
        companyId,
        roles,
        title,
        body: String(body.body || ""),
        target,
        kind: "manual",
      });
      if (!sent) {
        fail(
          res,
          400,
          "No hay usuarios con esos roles",
          "Ningún usuario activo tiene los roles elegidos"
        );
        return;
      }
      await logActivity({
        userId: session.sub,
        module: "notifications",
        moduleName: "Notificaciones",
        action: "create",
        entity: "notificacion",
        description: `Envió el aviso «${title}» a ${roles.join(", ")}`,
        companyId,
      });
      ok(res, sent === 1 ? "Aviso enviado" : `Aviso enviado a ${sent}`, {
        sent,
        roles,
        target,
      });
    } catch (e) {
      console.error("[admin/notifications] send:", e);
      fail(res, 500, "No se pudo enviar el aviso");
    }
    return;
  }

  fail(res, 400, `Acción desconocida: ${action || "(vacía)"}`);
});
