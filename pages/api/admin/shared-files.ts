import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { q } from "../../../lib/db";
import { requireAnyPermission, requirePermission } from "../../../lib/permissions";
import { ok, created, fail } from "../../../lib/api-response";
import {
  normalizeSharePath,
  isLocalPath,
} from "../../../lib/drive-paths";
import {
  SHARE_PERMISSIONS_DEFAULT,
  SharePermissions,
  normalizePermissions,
  shareCandidates,
  sharePathWith,
  sharesByOwner,
  sharesByTarget,
  unsharePathWith,
} from "../../../lib/user-shares";
import { requestScope } from "../../../lib/company-scope";

// ==================================================================
// MÓDULO "ARCHIVOS COMPARTIDOS"  ->  /api/admin/shared-files
//
// Un usuario comparte UNA carpeta de SU Drive con OTROS usuarios (uno o
// varios). Cada quien administra LO SUYO: para compartir o quitar hace falta
// ser el DUEÑO de la carpeta; el Admin puede quitarlo todo (soporte).
//
//   GET   ?folder=<ruta>            detalle de UNA carpeta que yo compartí
//                                 { path, targets: [...], candidates: [...] }
//   GET   (sin folder)              MIS compartidos y los RECIBIDOS
//                                 { shared: [...], received: [...], canShare, canDelete }
//   POST  { path, userIds: [..] }   comparte (o re-comparte) la carpeta
//   DELETE { path, userIds: [..] }  deja de compartir (baja lógica)
//
// La MISMA carpeta se comparte a VARIOS usuarios: al elegir la carpeta se
// marcan los usuarios que la reciben y se puede volver a entrar para sumar
// o quitar gente.
// ==================================================================

const norm = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Ids de usuario del cuerpo, sin repetir y mayores que 0. */
function userIdsOf(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw : [];
  return [...new Set(list.map((v) => Number(v)).filter((n) => n > 0))];
}

/**
 * Permisos por destinatario del cuerpo de la petición.
 *
 * Formatos aceptados (el panel manda `access`):
 *   * `access: [{ userId, view, edit, create, download }, ...]`
 *   * `userIds: [..]` + `permissions: { view, edit, create, download }`
 *     (los mismos permisos para todos).
 */
function accessOf(body: Record<string, unknown>): {
  userIds: number[];
  perms: Map<number, SharePermissions>;
} {
  const perms = new Map<number, SharePermissions>();
  const access = Array.isArray(body.access) ? body.access : [];
  for (const raw of access) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const id = Number(entry.userId ?? entry.id ?? 0);
    if (!(id > 0)) continue;
    perms.set(id, normalizePermissions(entry));
  }
  const ids = userIdsOf(body.userIds);
  const shared = normalizePermissions(body.permissions, SHARE_PERMISSIONS_DEFAULT);
  for (const id of ids) {
    if (!perms.has(id)) perms.set(id, shared);
  }
  return { userIds: [...perms.keys()], perms };
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  const me = await requireAnyPermission(req, res, "archivos compartidos");
  if (!me) return;

  // Permiso concreto por acción (el Admin pasa siempre).
  const actionOf: Record<string, "read" | "create" | "delete"> = {
    GET: "read",
    POST: "create",
    DELETE: "delete",
  };
  const action = actionOf[req.method || ""];
  if (!action) {
    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
    return;
  }
  const allowed = await requirePermission(req, res, "archivos compartidos", action);
  if (!allowed) return;

  // Alcance por empresa: solo se comparte DENTRO del mismo estudio.
  const scope = await requestScope(req, me);
  const companyId = scope.writeCompanyId;

  /** Ids de usuario que pertenecen a mi empresa. */
  async function sameCompanyIds(): Promise<Set<number>> {
    const rows = await q<{ id: number }>(
      "SELECT id FROM users WHERE active = 1 AND id_company = ?",
      [companyId]
    );
    return new Set(rows.map((r) => Number(r.id)));
  }

  // El módulo permite VER a todos, pero compartir no: el Cliente solo ve lo
  // que le comparten (la app le oculta los botones con el mismo criterio).
  const canShare = action === "read" ? await userCan("create") : true;
  const canDelete = action === "read" ? await userCan("delete") : true;

  /** ¿Mi rol puede [a] sobre este módulo? (el Admin siempre) */
  async function userCan(a: "create" | "delete"): Promise<boolean> {
    // Reutiliza el guardián real sin responder por HTTP: se consulta la tabla
    // de permisos del rol actual.
    try {
      const rows = await q<{ ok: number }>(
        `SELECT 1 AS ok
           FROM permissions_roles pr
           JOIN permissions p ON p.id = pr.id_permission AND p.active = 1
           JOIN modules m     ON m.id = pr.id_modules  AND m.active = 1
           JOIN users u       ON u.id_role = pr.id_role AND u.active = 1
          WHERE pr.active = 1 AND u.id = ?
            AND (LOWER(m.\`module\`) = 'shared_files' OR LOWER(m.name) = 'archivos compartidos')
            AND LOWER(p.\`key\`) = ?
          LIMIT 1`,
        [me.sub, a]
      );
      return rows.length > 0;
    } catch {
      // Sin migración aplicada: se permite (el módulo todavía no existe en la
      // BD y la app funciona en modo degradado).
      return true;
    }
  }

  /** ¿Mi rol es Admin? (pasa siempre). */
  async function iAmAdmin(): Promise<boolean> {
    try {
      const rows = await q<{ ok: number }>(
        `SELECT 1 AS ok FROM users u
           JOIN roles r ON r.id = u.id_role AND r.active = 1
          WHERE u.id = ? AND LOWER(r.name) = 'admin' LIMIT 1`,
        [me.sub]
      );
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  try {
    switch (req.method) {
      // ------------------------------------------------------------
      // GET: MIS compartidos, los recibidos, o el detalle de UNA carpeta.
      // ------------------------------------------------------------
      case "GET": {
        const folder = normalizeSharePath(norm(req.query.folder));

        if (folder) {
          const mine = (await sharesByOwner(me.sub, folder)).filter(
            (s) => s.targetId !== me.sub
          );
          return ok(res, "Carpeta compartida", {
            item: {
              path: folder,
              local: isLocalPath(folder),
              targets: mine.map((s) => ({
                id: s.targetId,
                name: s.targetName,
                shareId: s.id,
                // Lo que este usuario PODRÁ hacer en la carpeta: lo decide
                // quien comparte (no su rol).
                permissions: s.permissions,
              })),
            },
            candidates: await shareCandidates(me.sub, companyId),
            canShare,
            canDelete,
          });
        }

        const [shared, received, candidates] = await Promise.all([
          sharesByOwner(me.sub),
          sharesByTarget(me.sub),
          shareCandidates(me.sub, companyId),
        ]);
        return ok(res, "Archivos compartidos", {
          item: {
            shared,
            received,
            // Con quién se puede compartir (el resto de usuarios activos).
            candidates,
          },
          canShare,
          canDelete,
        });
      }

      // ------------------------------------------------------------
      // POST: compartir la carpeta con los usuarios elegidos.
      // ------------------------------------------------------------
      case "POST": {
        const b = (req.body || {}) as Record<string, unknown>;
        const path = normalizeSharePath(norm(b.path));
        const { userIds, perms } = accessOf(b);
        if (!path) {
          fail(res, 400, "Falta la carpeta", "Elige la carpeta que quieres compartir");
          return;
        }
        if (!userIds.length) {
          fail(res, 400, "Falta a quién", "Elige al menos un usuario");
          return;
        }
        // Solo dentro de la misma empresa.
        const allowedIds = await sameCompanyIds();
        const foreign = userIds.filter((id) => !allowedIds.has(id));
        if (foreign.length) {
          fail(
            res,
            403,
            "Hay usuarios de otra empresa",
            "Solo puedes compartir con usuarios de tu misma empresa"
          );
          return;
        }

        const out = await sharePathWith(me.sub, userIds, path, perms);
        if (
          out.shared === 0 &&
          out.already === 0 &&
          out.updated === 0 &&
          out.conflicts.length
        ) {
          fail(
            res,
            409,
            "Esa carpeta ya se solapa con otra que tienen compartida",
            `Ya reciben "${out.conflicts[0]}", que está dentro o contiene a esta carpeta`
          );
          return;
        }
        // NADA se guardó: decirlo. Antes esta respuesta salía como "Sin
        // cambios" (201) y el panel daba la carpeta por compartida, pero el
        // otro usuario recibía "no existe o ya no está compartida".
        if (out.shared === 0 && out.already === 0 && out.updated === 0) {
          fail(
            res,
            out.errors.length ? 500 : 409,
            "La carpeta no quedó compartida",
            out.errors[0] ||
              "No se guardó ningún destinatario: revisa que los usuarios sigan activos"
          );
          return;
        }

        const parts: string[] = [];
        if (out.shared) {
          parts.push(
            out.shared === 1
              ? "Compartida con 1 usuario"
              : `Compartida con ${out.shared} usuarios`
          );
        }
        if (out.updated) {
          parts.push(
            out.updated === 1
              ? "Permisos actualizados para 1 usuario"
              : `Permisos actualizados para ${out.updated} usuarios`
          );
        }
        if (out.already) {
          parts.push(
            out.already === 1
              ? "1 ya la tenía"
              : `${out.already} ya la tenían`
          );
        }
        if (out.conflicts.length) {
          parts.push(
            out.conflicts.length === 1
              ? "1 omitido por solaparse"
              : `${out.conflicts.length} omitidos por solaparse`
          );
        }
        if (out.errors.length) {
          // Algunos quedaron y otros no: se dice, para que no haya sorpresas
          // (el destinatario que falló no vería la carpeta).
          parts.push(
            out.errors.length === 1
              ? `1 no se pudo guardar (${out.errors[0]})`
              : `${out.errors.length} no se pudieron guardar`
          );
        }
        return created(res, parts.join(" · ") || "Sin cambios", {
          item: {
            path,
            shared: out.shared,
            already: out.already,
            updated: out.updated,
          },
          conflicts: out.conflicts,
          errors: out.errors,
        });
      }

      // ------------------------------------------------------------
      // DELETE: dejar de compartir (baja lógica).
      // ------------------------------------------------------------
      case "DELETE": {
        const b = (req.body || {}) as Record<string, unknown>;
        const path = normalizeSharePath(norm(b.path) || norm(req.query.path));
        let userIds = userIdsOf(b.userIds);
        if (!userIds.length) {
          userIds = userIdsOf(
            norm(req.query.userIds)
              .split(",")
              .map((s) => s.trim())
          );
        }
        if (!path) {
          fail(res, 400, "Falta la carpeta", "Indica la carpeta que quieres quitar");
          return;
        }
        if (!userIds.length) {
          fail(res, 400, "Falta a quién", "Indica a qué usuarios se la quitas");
          return;
        }

        // El dueño quita lo suyo; el Admin puede quitar lo de cualquiera
        // (soporte), pero SOLO lo que él mismo compartió.
        const admin = await iAmAdmin();
        if (!admin) {
          const mine = await sharesByOwner(me.sub, path);
          const mineIds = new Set(mine.map((s) => s.targetId));
          const notMine = userIds.filter((id) => !mineIds.has(id));
          if (notMine.length) {
            fail(
              res,
              403,
              "Esa carpeta no la compartiste tú",
              "Solo puedes dejar de compartir lo que compartiste con tu usuario"
            );
            return;
          }
        }

        const removed = await unsharePathWith(me.sub, userIds, path);
        return ok(res, removed
          ? removed === 1
            ? "Dejó de compartirse con 1 usuario"
            : `Dejó de compartirse con ${removed} usuarios`
          : "Esa carpeta ya no estaba compartida", {
          item: { path, removed },
        });
      }
    }
  } catch (e) {
    console.error("[admin/shared-files]", e);
    fail(res, 500, "Error interno del servidor", "Intenta de nuevo en un momento");
  }
});
