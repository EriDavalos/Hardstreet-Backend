// ==================================================================
// HARD STREET BACKEND - Carpetas del Drive compartidas
// ==================================================================
// El estudio le comparte a cada cliente las carpetas del Drive que quiera,
// por paquete comprado. El origen de verdad es la tabla
// `purchased_packages_drive` (VARIAS carpetas por paquete); la columna vieja
// `purchased_packages.drive_path` se conserva SINCRONIZADA con la primera
// carpeta, así los clientes que todavía la lean no se quedan sin datos.
//
// Estas reglas son las MISMAS que aplica el panel (app Flutter,
// lib/drive_base.dart):
//
//   * una ruta se normaliza: separador '/', sin barras al principio/final y
//     sin '.' ni '..';
//   * dos carpetas se SOLAPAN si son la misma o si una contiene a la otra.
//
// Compartir dos carpetas solapadas al MISMO cliente es un error: vería el
// mismo contenido dos veces (y el drive del cliente solo toma el primer nivel
// de cada ruta, así que la de dentro quedaría absorbida por la de fuera).
// ==================================================================

import { q } from "./db";

/** Normaliza una ruta del Drive ('' si no queda nada útil). */
export function normalizeDrivePath(path: unknown): string {
  return String(path ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s !== "" && s !== "." && s !== "..")
    .join("/");
}

/** ¿[a] y [b] son la misma carpeta o una está dentro de la otra? */
export function drivePathsOverlap(a: string, b: string): boolean {
  const x = normalizeDrivePath(a);
  const y = normalizeDrivePath(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** Acumula una carpeta normalizada sin repetirla. */
function pushPath(out: string[], raw: unknown): void {
  const p = normalizeDrivePath(raw);
  if (p && !out.includes(p)) out.push(p);
}

/**
 * Carpetas compartidas de UN paquete comprado (en su orden de alta).
 *
 * Lee la tabla nueva; si el paquete todavía no tiene filas ahí (migración sin
 * aplicar o carpeta guardada con la columna vieja) cae a `drive_path`.
 * Nunca lanza: sin migración devuelve lo que se pueda.
 */
export async function packageDrivePaths(
  purchasedPackageId: number
): Promise<string[]> {
  const out: string[] = [];
  try {
    const rows = await q<{ path: string }>(
      `SELECT path FROM purchased_packages_drive
        WHERE id_purchased_package = ? AND active = 1
        ORDER BY id ASC`,
      [purchasedPackageId]
    );
    for (const r of rows) pushPath(out, r.path);
    if (out.length) return out;
  } catch {
    // Tabla pendiente de migración: se usa la columna vieja.
  }
  try {
    const rows = await q<{ drive_path: string }>(
      `SELECT drive_path FROM purchased_packages WHERE id = ? AND active = 1`,
      [purchasedPackageId]
    );
    pushPath(out, rows[0]?.drive_path);
  } catch {
    // Sin columna tampoco: sin carpetas.
  }
  return out;
}

/** Versión en lote de [packageDrivePaths] (una sola consulta por tabla). */
export async function packageDrivePathsByIds(
  purchasedPackageIds: number[]
): Promise<Map<number, string[]>> {
  const ids = [...new Set(purchasedPackageIds.filter((n) => Number(n) > 0))];
  const map = new Map<number, string[]>();
  for (const id of ids) map.set(id, []);
  if (!ids.length) return map;

  // Carpetas de la tabla nueva.
  try {
    const rows = await q<{ id_purchased_package: number; path: string }>(
      `SELECT id_purchased_package, path FROM purchased_packages_drive
        WHERE active = 1 AND id_purchased_package IN (?)
        ORDER BY id ASC`,
      [ids]
    );
    for (const r of rows) {
      pushPath(map.get(Number(r.id_purchased_package)) ?? [], r.path);
    }
  } catch {
    // Tabla pendiente de migración.
  }

  // Paquetes SIN filas en la tabla nueva: se toma la columna vieja (así las
  // carpetas compartidas antes de la migración no desaparecen).
  const missing = ids.filter((id) => (map.get(id) ?? []).length === 0);
  if (missing.length) {
    try {
      const rows = await q<{ id: number; drive_path: string }>(
        `SELECT id, drive_path FROM purchased_packages WHERE id IN (?)`,
        [missing]
      );
      for (const r of rows) pushPath(map.get(Number(r.id)) ?? [], r.drive_path);
    } catch {
      // Sin columna: sin datos.
    }
  }
  return map;
}

/** Nombres (y carpetas) de los paquetes con los que comparte clientes [id]. */
async function siblingPackagePaths(
  purchasedPackageId: number
): Promise<{ id: number; name: string; paths: string[] }[]> {
  let rows: { id: number; name: string; drive_path: string | null }[];
  try {
    rows = await q<{ id: number; name: string; drive_path: string | null }>(
      `SELECT DISTINCT pp.id, pp.name, pp.drive_path
         FROM users_packages up
         JOIN purchased_packages pp
           ON pp.id = up.id_purchased_package AND pp.active = 1
        WHERE up.active = 1
          AND pp.id <> ?
          AND up.id_user IN (
            SELECT id_user FROM users_packages
             WHERE id_purchased_package = ? AND active = 1
          )`,
      [purchasedPackageId, purchasedPackageId]
    );
  } catch {
    // Columna pendiente de migración: sin validación posible.
    return [];
  }
  const folders = await packageDrivePathsByIds(rows.map((r) => Number(r.id)));
  return rows.map((r) => ({
    id: Number(r.id),
    name: String(r.name || ""),
    paths: folders.get(Number(r.id)) ?? [],
  }));
}

/**
 * ¿Algún cliente de la compra [purchasedPackageId] ya tiene compartida, en
 * OTRO de sus paquetes, una carpeta que se solapa con [path]?
 *
 * Devuelve esa carpeta (para poder decirle al usuario cuál es) o null.
 */
export async function sharedDriveConflict(
  purchasedPackageId: number,
  path: string
): Promise<string | null> {
  const target = normalizeDrivePath(path);
  if (!target) return null;
  for (const sib of await siblingPackagePaths(purchasedPackageId)) {
    for (const other of sib.paths) {
      if (drivePathsOverlap(target, other)) return other;
    }
  }
  return null;
}
