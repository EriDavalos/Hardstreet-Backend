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

/**
 * ¿[path] es una ruta LOCAL absoluta de la computadora del usuario?
 * ("C:\\Fotos", "D:/Eventos", "/home/ana/fotos", "\\\\NAS\\shares").
 *
 * El módulo "Archivos compartidos" permite compartir una CARPETA LOCAL: esas
 * rutas NO viven dentro del Drive del servidor, así que se normalizan distinto
 * (conservando su raíz) y se sirven con los endpoints /api/local/*.
 */
export function isLocalPath(path: unknown): boolean {
  const s = String(path ?? "").trim();
  if (!s) return false;
  return /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("/") || s.startsWith("\\\\");
}

/**
 * Normaliza una ruta LOCAL conservando su raíz: separador '/', sin '.' ni
 * '..' y sin barras repetidas. `C:\\Fotos\\` → `C:/Fotos`; `/home/ana//x` →
 * `/home/ana/x`. Devuelve '' si no queda nada.
 */
export function normalizeLocalPath(path: unknown): string {
  const s = String(path ?? "").trim().replace(/\\/g, "/");
  if (!s) return "";
  const drive = /^([A-Za-z]):/.exec(s);
  const rest = s.replace(/^([A-Za-z]:)?\/+/, "");
  const parts = rest
    .split("/")
    .map((x) => x.trim())
    .filter((x) => x && x !== "." && x !== "..");
  const joined = parts.join("/");
  if (drive) return joined ? `${drive[1].toUpperCase()}:/${joined}` : `${drive[1].toUpperCase()}:/`;
  return joined ? `/${joined}` : "/";
}

/** Normaliza una ruta que puede ser del Drive o local. */
export function normalizeSharePath(path: unknown): string {
  return isLocalPath(path) ? normalizeLocalPath(path) : normalizeDrivePath(path);
}

/** ¿Dos rutas LOCALES son la misma o una contiene a la otra? (sin distinguir
 * mayúsculas: Windows no las distingue). */
export function localPathsOverlap(a: string, b: string): boolean {
  const x = normalizeLocalPath(a).toLowerCase();
  const y = normalizeLocalPath(b).toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  const xs = x.endsWith("/") ? x : `${x}/`;
  const ys = y.endsWith("/") ? y : `${y}/`;
  return xs.startsWith(ys) || ys.startsWith(xs);
}

/** ¿Se solapan dos rutas cualesquiera (del Drive o locales)? */
export function pathsOverlap(a: string, b: string): boolean {
  if (isLocalPath(a) && isLocalPath(b)) return localPathsOverlap(a, b);
  return drivePathsOverlap(a, b);
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
    // OJO: `COALESCE(id_user, 0) = 0` deja fuera las carpetas compartidas
    // DIRECTAMENTE con el cliente (esas salen en [userDrivePaths]): si no, la
    // carpeta del cliente se leería también como carpeta del paquete.
    const rows = await q<{ path: string }>(
      `SELECT path FROM purchased_packages_drive
        WHERE id_purchased_package = ? AND active = 1
          AND COALESCE(id_user, 0) = 0
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

  // Carpetas de la tabla nueva (solo las DEL PAQUETE: las del cliente se
  // piden aparte con [userDrivePathsByIds]).
  try {
    const rows = await q<{ id_purchased_package: number; path: string }>(
      `SELECT id_purchased_package, path FROM purchased_packages_drive
        WHERE active = 1 AND id_purchased_package IN (?)
          AND COALESCE(id_user, 0) = 0
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
 * Carpetas compartidas DIRECTAMENTE con un CLIENTE (con `id_user`), sin
 * importar el paquete: el cliente las ve en TODOS sus paquetes.
 *
 * Devuelve [] si la migración (columna `id_user`) todavía no se aplicó.
 */
export async function userDrivePaths(userId: number): Promise<string[]> {
  const out: string[] = [];
  if (!userId) return out;
  try {
    const rows = await q<{ path: string }>(
      `SELECT path FROM purchased_packages_drive
        WHERE id_user = ? AND active = 1
        ORDER BY id ASC`,
      [userId]
    );
    for (const r of rows) pushPath(out, r.path);
  } catch {
    // Columna pendiente de migración: sin carpetas del cliente.
  }
  return out;
}

/** Versión en lote de [userDrivePaths]. */
export async function userDrivePathsByIds(
  userIds: number[]
): Promise<Map<number, string[]>> {
  const ids = [...new Set(userIds.filter((n) => Number(n) > 0))];
  const map = new Map<number, string[]>();
  for (const id of ids) map.set(id, []);
  if (!ids.length) return map;
  try {
    const rows = await q<{ id_user: number; path: string }>(
      `SELECT id_user, path FROM purchased_packages_drive
        WHERE active = 1 AND id_user IN (?)
        ORDER BY id ASC`,
      [ids]
    );
    for (const r of rows) pushPath(map.get(Number(r.id_user)) ?? [], r.path);
  } catch {
    // Columna pendiente de migración.
  }
  return map;
}

/**
 * ¿Una carpeta COMPARTIDA DIRECTAMENTE con el cliente [userId] se solapa con
 * [path]? Devuelve esa carpeta o null.
 */
export async function userSharedConflict(
  userId: number,
  path: string
): Promise<string | null> {
  const target = normalizeDrivePath(path);
  if (!target || !userId) return null;
  for (const other of await userDrivePaths(userId)) {
    if (drivePathsOverlap(target, other)) return other;
  }
  return null;
}

/**
 * ¿Algún cliente de la compra [purchasedPackageId] ya tiene compartida, en
 * OTRO de sus paquetes (o directamente con su usuario), una carpeta que se
 * solapa con [path]?
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
  // Y las compartidas DIRECTO al cliente de ese paquete.
  for (const cid of await packageClientIds(purchasedPackageId)) {
    const clash = await userSharedConflict(cid, target);
    if (clash) return clash;
  }
  return null;
}

/** Clientes (usuarios) vinculados a un paquete comprado. */
export async function packageClientIds(
  purchasedPackageId: number
): Promise<number[]> {
  try {
    const rows = await q<{ id_user: number }>(
      `SELECT DISTINCT id_user FROM users_packages
        WHERE id_purchased_package = ? AND active = 1`,
      [purchasedPackageId]
    );
    return rows.map((r) => Number(r.id_user)).filter((n) => n > 0);
  } catch {
    return [];
  }
}
