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
// Además, CADA servicio dice QUÉ opciones le salen al cliente en «Mi paquete»
// (migración 2026-10-16_opciones_por_servicio.sql):
//
//   * `pick_photos` → el cliente ve «Elegir fotos» / «Mis fotos (N)»
//   * `show_folder` → el cliente ve «Abrir carpeta» (si hay carpeta compartida)
//
// Antes «Elegir fotos» salía en TODOS los servicios; ahora lo enciende el
// estudio servicio por servicio.
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

  /** ¿El cliente puede ELEGIR fotos de su Drive para este servicio? */
  pickPhotos: boolean;

  /** ¿Se le muestra «Abrir carpeta» cuando hay carpeta compartida? */
  showFolder: boolean;
}

function normLink(v: unknown): string {
  return String(v ?? "").trim();
}

/**
 * Un servicio sin nada configurado.
 *
 * Los valores por defecto son los de una fila nueva: elegir fotos APAGADO (el
 * estudio lo enciende donde quiera) y la carpeta ENCENDIDA (como venía siendo:
 * el botón solo sale si además hay una carpeta compartida).
 */
function emptyShare(): ServiceShare {
  return { folder: "", link: "", items: 0, pickPhotos: false, showFolder: true };
}

/** `1`/`true` → true (las columnas son tinyint). */
function asFlag(v: unknown, fallback: boolean): boolean {
  if (v === null || v === undefined || v === "") return fallback;
  if (typeof v === "boolean") return v;
  return Number(v) === 1;
}

/** Opciones de compartir de VARIOS servicios, en UNA consulta por tabla. */
export async function serviceSharesByIds(
  purchasedPackageServiceIds: number[]
): Promise<Map<number, ServiceShare>> {
  const ids = [...new Set(purchasedPackageServiceIds.filter((n) => Number(n) > 0))];
  const map = new Map<number, ServiceShare>();
  for (const id of ids) map.set(id, emptyShare());
  if (!ids.length) return map;

  // Carpeta, liga y las opciones que se encienden por SERVICIO.
  type ShareRow = {
    id_purchased_package_service: number;
    folder: string | null;
    link: string | null;
    pick_photos?: number | null;
    show_folder?: number | null;
  };
  try {
    const rows = await q<ShareRow>(
      `SELECT id_purchased_package_service, folder, link, pick_photos, show_folder
         FROM purchased_packages_services_shares
        WHERE active = 1 AND id_purchased_package_service IN (?)`,
      [ids]
    );
    for (const r of rows) {
      const entry = map.get(Number(r.id_purchased_package_service));
      if (!entry) continue;
      entry.folder = normalizeDrivePath(r.folder);
      entry.link = normLink(r.link);
      entry.pickPhotos = asFlag(r.pick_photos, false);
      entry.showFolder = asFlag(r.show_folder, true);
    }
  } catch {
    // Migración de las OPCIONES pendiente (la tabla ya existía): se leen la
    // carpeta y la liga, y las opciones se quedan con sus valores de siempre.
    try {
      const rows = await q<ShareRow>(
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
      // Tabla todavía sin crear: sin carpeta ni liga.
    }
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
  return all.get(Number(purchasedPackageServiceId)) ?? emptyShare();
}

/**
 * Guarda (o borra) la carpeta, la liga y las OPCIONES de UN servicio.
 *
 * [pickPhotos] = el cliente puede elegir fotos para este servicio;
 * [showFolder] = se le muestra «Abrir carpeta» (si tiene carpeta).
 */
export async function saveServiceShare(
  purchasedPackageServiceId: number,
  folder: string,
  link: string,
  pickPhotos = false,
  showFolder = true
): Promise<void> {
  const f = normalizeDrivePath(folder);
  const l = normLink(link);
  const values = [
    purchasedPackageServiceId,
    f || null,
    l || null,
    pickPhotos ? 1 : 0,
    showFolder ? 1 : 0,
  ];
  try {
    await exec(
      `INSERT INTO purchased_packages_services_shares
         (id_purchased_package_service, folder, link, pick_photos, show_folder)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE folder = VALUES(folder), link = VALUES(link),
                               pick_photos = VALUES(pick_photos),
                               show_folder = VALUES(show_folder), active = 1`,
      values
    );
  } catch {
    // BD sin la migración de las opciones: se guardan la carpeta y la liga
    // como antes (la carpeta del cliente no se debe perder por esto).
    await exec(
      `INSERT INTO purchased_packages_services_shares
         (id_purchased_package_service, folder, link)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE folder = VALUES(folder), link = VALUES(link),
                               active = 1`,
      [purchasedPackageServiceId, f || null, l || null]
    );
  }
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
