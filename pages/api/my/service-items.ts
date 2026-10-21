import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requireUser } from "../../../lib/auth";
import { q } from "../../../lib/db";
import { userIsAdmin, userRoleId } from "../../../lib/permissions";
import { normalizeDrivePath } from "../../../lib/drive-paths";
import {
  serviceItems,
  serviceShare,
  replaceServiceItems,
} from "../../../lib/service-shares";
import { servicePrintLocked } from "../../../lib/print-requests";

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
//   * «Elegir fotos» lo enciende el estudio y SOLO si el servicio del catálogo
//     tiene un máximo (> 0) y se compartió su carpeta;
//   * el cliente elige DENTRO de la carpeta compartida de ESE servicio (no ve
//     el resto del Drive) y como máximo `photos_max` fotos.
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

      // Enviado a impresión = selección BLOQUEADA: solo se puede ver hasta
      // que el estudio reabra el envío desde el módulo de impresiones.
      const locked = await servicePrintLocked(serviceId);
      if (locked) {
        res.status(409).json({
          error:
            locked.status === "finished"
              ? "Estas fotos ya se imprimieron. Pídele al estudio que reabra el envío."
              : "Ya enviaste estas fotos a impresión. Pídele al estudio que reabra el envío para cambiarlas.",
          printStatus: locked.status,
          requestId: locked.id,
        });
        return;
      }

      // Qué ofrece ESTE servicio: su carpeta compartida y su máximo de fotos.
      const info = await servicePickInfo(serviceId);
      // El ESTUDIO (admin) también puede marcar la selección por si el
      // cliente no puede hacerlo: no necesita que «Elegir fotos» esté
      // encendido, pero sí la carpeta compartida (el cliente solo ve eso).
      if (!info.pickPhotos && !isAdmin) {
        res.status(400).json({
          error: "Elegir fotos no está disponible para este servicio",
        });
        return;
      }
      if (!info.folder) {
        res.status(400).json({
          error: "El servicio todavía no tiene una carpeta compartida",
        });
        return;
      }
      // `max = 0` en configuraciones viejas significa «sin máximo»: se sigue
      // permitiendo (la carpeta compartida sí es obligatoria).
      const rawPaths = Array.isArray(b.paths) ? b.paths : [];
      const paths = rawPaths
        .map((p) => normalizeDrivePath(p))
        .filter((p) => p !== "")
        .filter((p, i, all) => all.indexOf(p) === i);

      if (info.max > 0 && paths.length > info.max) {
        res.status(400).json({
          error: `Puedes elegir como máximo ${info.max} ${info.max === 1 ? 'foto' : 'fotos'}`,
          max: info.max,
        });
        return;
      }

      // Solo lo que está DENTRO de la carpeta compartida del servicio.
      const folder = normalizeDrivePath(info.folder);
      const fuera = paths.filter(
        (p) => p !== folder && !p.startsWith(`${folder}/`)
      );
      if (fuera.length) {
        res.status(400).json({
          error: "Solo puedes elegir fotos de la carpeta compartida del servicio",
          invalid: fuera.slice(0, 5),
        });
        return;
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
    const info = await servicePickInfo(serviceId);
    const print = await servicePrintLocked(serviceId);
    res.status(200).json({
      serviceId,
      items: await serviceItems(serviceId),
      // Lo que el cliente necesita para el módulo de selección.
      folder: info.folder,
      max: info.max,
      pickPhotos: info.pickPhotos,
      // Envío a impresión activo (si lo hay): el cliente VE sus fotos pero no
      // las puede cambiar hasta que el estudio lo reabra.
      printStatus: print?.status ?? "",
      printRequestId: print?.id ?? null,
      sent: print !== null,
    });
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

/**
 * Lo que ofrece el servicio para la selección: carpeta compartida, máximo de
 * fotos del catálogo y si el estudio encendió «Elegir fotos».
 */
async function servicePickInfo(serviceId: number): Promise<{
  folder: string;
  max: number;
  pickPhotos: boolean;
}> {
  const share = await serviceShare(serviceId);
  let max = 0;
  try {
    const rows = await q<{ photos_max: number | null }>(
      `SELECT s.photos_max
         FROM purchased_packages_services pps
         JOIN services s ON s.id = pps.id_service
        WHERE pps.id = ? AND pps.active = 1`,
      [serviceId]
    );
    max = Math.max(0, Number(rows[0]?.photos_max) || 0);
  } catch {
    // Migración pendiente: sin máximo no se puede elegir.
    max = 0;
  }
  return { folder: share.folder, max, pickPhotos: share.pickPhotos };
}
