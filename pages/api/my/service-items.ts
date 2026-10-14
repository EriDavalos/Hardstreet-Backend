import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requireUser } from "../../../lib/auth";
import { q } from "../../../lib/db";
import { userIsAdmin, userRoleId } from "../../../lib/permissions";
import { normalizeDrivePath, drivePathsOverlap, packageDrivePathsByIds } from "../../../lib/drive-paths";
import { serviceItems, replaceServiceItems } from "../../../lib/service-shares";

// ==================================================================
// SELECCIÓN de elementos/fotos de UN servicio del paquete -> /api/my/service-items
//
//   GET  ?serviceId=N  { serviceId, items: [ "carpeta/foto.jpg", ... ] }
//   PUT  { serviceId, paths: [...] }  -> reemplaza la selección
//
// El CLIENTE marca qué elementos de SU Drive quiere para ese servicio (p. ej.
// las fotos que se van a imprimir). Se guarda la LISTA de rutas: nada se mueve
// ni se copia de carpeta.
//
// Reglas:
//   * el servicio tiene que pertenecer a un paquete ACTIVO del usuario (el
//     equipo del estudio, con rol Admin, puede tocar cualquiera);
//   * las rutas deben caer dentro de las carpetas COMPARTIDAS con el cliente
//     (no se puede marcar de una carpeta que no ve); si el usuario no tiene
//     ninguna carpeta compartida (p. ej. un admin), no se restringe.
//
// Sin la migración aplicada la lectura devuelve [] en vez de fallar.
// ==================================================================

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  const session = await requireUser(req, res);
  if (!session) return;

  try {
    const roleId = await userRoleId(session.sub);
    const isAdmin = await userIsAdmin(roleId);

    // ---- PUT: reemplaza la selección ----
    if (req.method === "PUT" || req.method === "POST") {
      const b = (req.body || {}) as Record<string, unknown>;
      const serviceId = Number(b.serviceId || 0);
      if (!serviceId) {
        res.status(400).json({ error: "Indica el servicio del paquete" });
        return;
      }
      const allowed = await ownsService(session.sub, serviceId, isAdmin);
      if (!allowed) {
        res.status(404).json({ error: "Ese servicio no pertenece a tus paquetes" });
        return;
      }

      const rawPaths = Array.isArray(b.paths) ? b.paths : [];
      const paths = rawPaths
        .map((p) => normalizeDrivePath(p))
        .filter((p) => p !== "");

      // Las rutas se marcan DENTRO de lo compartido (si hay algo compartido).
      const roots = await sharedRoots(session.sub, isAdmin);
      if (roots.length) {
        const fuera = paths.filter(
          (p) => !roots.some((r) => drivePathsOverlap(p, r))
        );
        if (fuera.length) {
          res.status(400).json({
            error: "Solo puedes elegir elementos de tus carpetas compartidas",
            invalid: fuera.slice(0, 5),
          });
          return;
        }
      }

      const saved = await replaceServiceItems(serviceId, paths);
      res.status(200).json({ serviceId, items: saved });
      return;
    }

    if (req.method !== "GET") {
      res.status(405).json({ error: "Metodo no permitido" });
      return;
    }

    // ---- GET: la lista guardada ----
    const serviceId = Number(req.query.serviceId || 0);
    if (!serviceId) {
      res.status(400).json({ error: "Indica el servicio del paquete" });
      return;
    }
    const allowed = await ownsService(session.sub, serviceId, isAdmin);
    if (!allowed) {
      res.status(404).json({ error: "Ese servicio no pertenece a tus paquetes" });
      return;
    }
    res.status(200).json({ serviceId, items: await serviceItems(serviceId) });
  } catch (e) {
    console.error("[my/service-items]", e);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

/** ¿El servicio [serviceId] pertenece a un paquete ACTIVO del usuario? */
async function ownsService(
  userId: number,
  serviceId: number,
  isAdmin: boolean
): Promise<boolean> {
  if (isAdmin) return true;
  const rows = await q<{ id: number }>(
    `SELECT pps.id
       FROM purchased_packages_services pps
       JOIN users_packages up
         ON up.id_purchased_package = pps.id_purchased_package AND up.active = 1
      WHERE pps.id = ? AND pps.active = 1 AND up.id_user = ?`,
    [serviceId, userId]
  );
  return rows.length > 0;
}

/** Carpetas compartidas con el usuario (vacío = sin restricción). */
async function sharedRoots(userId: number, isAdmin: boolean): Promise<string[]> {
  if (isAdmin) return [];
  try {
    const rows = await q<{ id: number }>(
      `SELECT DISTINCT pp.id
         FROM users_packages up
         JOIN purchased_packages pp
           ON pp.id = up.id_purchased_package AND pp.active = 1
        WHERE up.id_user = ? AND up.active = 1`,
      [userId]
    );
    const folders = await packageDrivePathsByIds(rows.map((r) => Number(r.id)));
    const out: string[] = [];
    for (const list of folders.values()) {
      for (const p of list) if (!out.includes(p)) out.push(p);
    }
    return out;
  } catch {
    return [];
  }
}
