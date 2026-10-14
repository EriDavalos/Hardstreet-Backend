// ==================================================================
// HARD STREET BACKEND - Opciones de compartir de un SERVICIO del paquete
// ==================================================================
// Cada servicio de un paquete comprado (purchased_packages_services) puede
// compartir con el cliente:
//
//   * una CARPETA del Drive  -> purchased_packages_services_shares.folder
//   * una LIGA               -> purchased_packages_services_shares.link
//   * una SELECCIÓN de elementos/fotos que el CLIENTE marca en su Drive ->
//     purchased_packages_services_items (una fila por ruta; NADA se mueve ni
//     se copia de carpeta, solo se guarda la lista).
//
// El origen de verdad son esas dos tablas, perezosas: si la migración todavía
// no se aplicó, todo cae a "sin opciones" en vez de fallar la petición (el
// panel tiene que seguir funcionando con un backend viejo o una BD sin migrar).
// ==================================================================

import { q, exec } from "./db";
import { normalizeDrivePath } from "./drive-paths";

export interface ServiceShare {
  folder: string;
  link: string;
  items: number;
}

function normLink(v: unknown): string {
  return String(v ?? "").trim();
}

/** Opciones de compartir de VARIOS servicios, en UNA consulta por tabla. */
export async function serviceSharesByIds(
  purchasedPackageServiceIds: number[]
): Promise<Map<number, ServiceShare>> {
  const ids = [...new Set(purchasedPackageServiceIds.filter((n) => Number(n) > 0))];
  const map = new Map<number, ServiceShare>();
  for (const id of ids) map.set(id, { folder: "", link: "", items: 0 });
  if (!ids.length) return map;

  // Carpeta + liga (tabla nueva).
  try {
    const rows = await q<{ id_purchased_package_service: number; folder: string | null; link: string | null }>(
      `SELECT id_purchased_package_service, folder, link
         FROM purchased_packages_services_shares
        WHERE active = 1 AND id_purchased_package_service IN (?)`,
      [ids]
    );
    for (const r of rows) {
      const entry = map.get(Number(r.id_purchased_package_service));
      if (!entry) continue;
      entry.folder = normalizeDrivePath(r.folder);
      entry.link = normLink(r.link);
    }
  } catch {
    // Migración pendiente: sin carpeta ni liga.
  }

  // Selección del cliente: solo el CONTEO (la lista completa la pide el
  // endpoint del servicio cuando hace falta).
  try {
    const rows = await q<{ id_purchased_package_service: number; total: number }>(
      `SELECT id_purchased_package_service, COUNT(*) AS total
         FROM purchased_packages_services_items
        WHERE active = 1 AND id_purchased_package_service IN (?)
        GROUP BY id_purchased_package_service`,
      [ids]
    );
    for (const r of rows) {
      const entry = map.get(Number(r.id_purchased_package_service));
      if (entry) entry.items = Number(r.total) || 0;
    }
  } catch {
    // Migración pendiente: sin selección.
  }

  return map;
}

/** Opciones de compartir de UN servicio. */
export async function serviceShare(
  purchasedPackageServiceId: number
): Promise<ServiceShare> {
  const all = await serviceSharesByIds([purchasedPackageServiceId]);
  return all.get(Number(purchasedPackageServiceId)) ?? {
    folder: "",
    link: "",
    items: 0,
  };
}

/** Guarda (o borra) la carpeta y la liga compartidas de UN servicio. */
export async function saveServiceShare(
  purchasedPackageServiceId: number,
  folder: string,
  link: string
): Promise<void> {
  const f = normalizeDrivePath(folder);
  const l = normLink(link);
  await exec(
    `INSERT INTO purchased_packages_services_shares
       (id_purchased_package_service, folder, link)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE folder = VALUES(folder), link = VALUES(link),
                             active = 1`,
    [purchasedPackageServiceId, f || null, l || null]
  );
}

/** La LISTA de elementos que el cliente marcó para UN servicio. */
export async function serviceItems(
  purchasedPackageServiceId: number
): Promise<string[]> {
  try {
    const rows = await q<{ path: string }>(
      `SELECT path FROM purchased_packages_services_items
        WHERE active = 1 AND id_purchased_package_service = ?
        ORDER BY id ASC`,
      [purchasedPackageServiceId]
    );
    return rows.map((r) => normalizeDrivePath(r.path)).filter((p) => p !== "");
  } catch {
    // Migración pendiente: sin selección.
    return [];
  }
}

/**
 * REEMPLAZA la selección de UN servicio por [paths] (deduplicada y
 * normalizada). No toca las rutas de otros servicios.
 */
export async function replaceServiceItems(
  purchasedPackageServiceId: number,
  paths: unknown[]
): Promise<string[]> {
  const clean: string[] = [];
  for (const raw of paths) {
    const p = normalizeDrivePath(raw);
    if (p && !clean.includes(p)) clean.push(p);
  }

  // Baja lógica de lo anterior y alta de lo nuevo (así el historial queda).
  await exec(
    `UPDATE purchased_packages_services_items
        SET active = 0
      WHERE active = 1 AND id_purchased_package_service = ?`,
    [purchasedPackageServiceId]
  );
  for (const p of clean) {
    await exec(
      `INSERT INTO purchased_packages_services_items
         (id_purchased_package_service, path)
       VALUES (?, ?)`,
      [purchasedPackageServiceId, p]
    );
  }
  return clean;
}
