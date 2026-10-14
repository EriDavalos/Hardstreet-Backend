// ==================================================================
// HARD STREET BACKEND - Carpetas del Drive compartidas
// ==================================================================
// El estudio le comparte a cada cliente UNA carpeta del Drive por paquete
// (`purchased_packages.drive_path`). Estas reglas son las MISMAS que aplica el
// panel (app Flutter, lib/drive_base.dart):
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

/**
 * ¿Algún cliente de la compra [purchasedPackageId] ya tiene compartida, en
 * OTRO de sus paquetes, una carpeta que se solapa con [path]?
 *
 * Devuelve esa carpeta (para poder decirle al usuario cuál es) o null.
 * Es INSENSIBLE a un backend sin la migración: si la columna `drive_path`
 * todavía no existe, simplemente no valida (igual que el resto del panel).
 */
export async function sharedDriveConflict(
  purchasedPackageId: number,
  path: string
): Promise<string | null> {
  const target = normalizeDrivePath(path);
  if (!target) return null;
  let rows: { id: number; drive_path: string }[];
  try {
    rows = await q<{ id: number; drive_path: string }>(
      `SELECT DISTINCT pp.id, pp.drive_path
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
    return null;
  }
  for (const r of rows) {
    const other = normalizeDrivePath(r.drive_path);
    if (other && drivePathsOverlap(target, other)) return other;
  }
  return null;
}
