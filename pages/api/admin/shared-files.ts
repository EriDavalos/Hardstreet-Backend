import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { q } from "../../../lib/db";
import { requireAnyPermission, requirePermission } from "../../../lib/permissions";
import { ok, created, fail } from "../../../lib/api-response";
import { normalizeDrivePath } from "../../../lib/drive-paths";
import {
  shareCandidates,
  sharePathWith,
  sharesByOwner,
  sharesByTarget,
  unsharePathWith,
} from "../../../lib/user-shares";

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
        const folder = normalizeDrivePath(norm(req.query.folder));

        if (folder) {
          const mine = (await sharesByOwner(me.sub, folder)).filter(
            (s) => s.targetId !== me.sub
          );
          return ok(res, "Carpeta compartida", {
            item: {
              path: folder,
              targets: mine.map((s) => ({
                id: s.targetId,
                name: s.targetName,
                shareId: s.id,
              })),
            },
            candidates: await shareCandidates(me.sub),
            canShare,
            canDelete,
          });
        }

        const [shared, received, candidates] = await Promise.all([
          sharesByOwner(me.sub),
          sharesByTarget(me.sub),
          shareCandidates(me.sub),
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
        const path = normalizeDrivePath(norm(b.path));
        const userIds = userIdsOf(b.userIds);
        if (!path) {
          fail(res, 400, "Falta la carpeta", "Elige la carpeta que quieres compartir");
          return;
        }
        if (!userIds.length) {
          fail(res, 400, "Falta a quién", "Elige al menos un usuario");
          return;
        }

        const out = await sharePathWith(me.sub, userIds, path);
        if (out.shared === 0 && out.already === 0 && out.conflicts.length) {
          fail(
            res,
            409,
            "Esa carpeta ya se solapa con otra que tienen compartida",
            `Ya reciben "${out.conflicts[0]}", que está dentro o contiene a esta carpeta`
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
        return created(res, parts.join(" · ") || "Sin cambios", {
          item: { path, shared: out.shared, already: out.already },
          conflicts: out.conflicts,
        });
      }

      // ------------------------------------------------------------
      // DELETE: dejar de compartir (baja lógica).
      // ------------------------------------------------------------
      case "DELETE": {
        const b = (req.body || {}) as Record<string, unknown>;
        const path = normalizeDrivePath(norm(b.path) || norm(req.query.path));
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
