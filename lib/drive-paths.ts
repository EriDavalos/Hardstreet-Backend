// ==================================================================
// HARD STREET BACKEND - Carpetas del Drive compartidas
// ==================================================================
// El estudio le comparte a cada cliente las carpetas del Drive que quiera.
// El origen de verdad es la tabla `users_drive` (antes
// `purchased_packages_drive`: el Drive se le comparte AL CLIENTE, el paquete
// solo dice desde cuál aparece); la columna vieja
// `purchased_packages.drive_path` se conserva SINCRONIZADA con la primera
// carpeta, así los clientes que todavía la lean no se quedan sin datos.
//
// Alcance de cada fila (es lo que decide QUIÉN la ve):
//
//   * con `id_purchased_package`  -> carpeta DEL PAQUETE. El cliente la ve
//     mientras ese paquete esté activo y solo desde él.
//   * con `id_user` y SIN paquete -> carpeta de LA PERSONA. La ve en todos
//     sus paquetes (se administra en el módulo Usuarios).
//
// `drive_path` es SOLO un respaldo para paquetes anteriores a la migración
// (los que nunca tuvieron filas en `users_drive`). En cuanto un paquete tiene
// filas ahí, manda la tabla: si todas están en `active = 0` es porque se dejó
// de compartir, y el respaldo NO debe resucitar la carpeta (eso hacía que una
// carpeta ya quitada siguiera apareciendo como "compartida" y bloqueara
// compartir otra que se solapaba con ella).
//
// Las filas viejas, que nacieron al compartir la carpeta de un paquete CON el
// cliente, traen las dos columnas. Se tratan como carpeta DEL PAQUETE (es lo
// que eran en realidad): si no, esa carpeta no salía en la pestaña Drive del
// paquete ("sin carpeta") y al mismo tiempo bloqueaba compartirla como si ya
// estuviera compartida con el cliente.
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

/**
 * Explica en palabras la relación entre una carpeta YA compartida y la que se
 * quiere compartir (se solapan). Sirve para que el aviso diga qué pasa de
 * verdad: misma carpeta, una contiene a la otra o está dentro de ella.
 */
export function overlapReason(shared: string, target: string): string {
  const a = normalizeDrivePath(shared);
  const b = normalizeDrivePath(target);
  if (!a) return `«${b}» se solapa con una carpeta ya compartida`;
  if (a === b) return `«${a}» ya está compartida`;
  if (b.startsWith(`${a}/`)) {
    return `«${a}» ya está compartida y CONTIENE a «${b}»`;
  }
  if (a.startsWith(`${b}/`)) {
    return `«${a}» ya está compartida y está DENTRO de «${b}»`;
  }
  return `«${a}» ya está compartida y se solapa con «${b}»`;
}

/**
 * Nombre REAL de la tabla de carpetas compartidas.
 *
 * Desde la migración 2026-10-27 se llama `users_drive`; si el backend arrancó
 * antes de aplicarla (o la base todavía no la tiene) se sigue usando
 * `purchased_packages_drive`, para no dejar el Drive de los clientes vacío
 * por un rename pendiente. Se resuelve una vez y se recuerda; mientras no
 * exista `users_drive` se vuelve a comprobar (se autocorrige al aplicarla).
 */
let driveTableName: string | null = null;
export async function driveTable(): Promise<string> {
  if (driveTableName) return driveTableName;
  try {
    await q("SELECT 1 FROM users_drive LIMIT 1");
    driveTableName = "users_drive";
    return driveTableName;
  } catch {
    return "purchased_packages_drive";
  }
}

/** Acumula una carpeta normalizada sin repetirla. */
function pushPath(out: string[], raw: unknown): void {
  const p = normalizeDrivePath(raw);
  if (p && !out.includes(p)) out.push(p);
}

/**
 * Carpetas compartidas de UN paquete comprado (en su orden de alta).
 *
 * Lee la tabla `users_drive`; cae a la columna vieja `drive_path` SOLO si el
 * paquete nunca tuvo filas ahí (datos anteriores a la migración), no cuando
 * las que tiene están en `active = 0` (eso es "se dejó de compartir").
 * Nunca lanza: sin migración devuelve lo que se pueda.
 */
export async function packageDrivePaths(
  purchasedPackageId: number
): Promise<string[]> {
  const out: string[] = [];
  let hasRows = false;
  try {
    // Todas las filas atadas al paquete cuentan como SUYAS, incluida la fila
    // vieja que además trae `id_user` (ver la cabecera del archivo). Se traen
    // también las inactivas: sirven para saber si la tabla ya es la fuente.
    const rows = await q<{ path: string; active: number }>(
      `SELECT path, active FROM ${await driveTable()}
        WHERE id_purchased_package = ?
        ORDER BY id ASC`,
      [purchasedPackageId]
    );
    hasRows = rows.length > 0;
    for (const r of rows) if (Number(r.active) === 1) pushPath(out, r.path);
  } catch {
    // Tabla pendiente de migración: se usa la columna vieja.
    hasRows = false;
  }
  if (hasRows) return out;
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

  // Carpetas de la tabla (solo las DEL PAQUETE: las del cliente se piden
  // aparte con [userDrivePathsByIds]). Las filas viejas con `id_user` también
  // son del paquete: ver la cabecera del archivo. Se traen también las
  // inactivas para distinguir "se dejó de compartir" de "nunca hubo filas".
  const withRows = new Set<number>();
  try {
    const rows = await q<{
      id_purchased_package: number;
      path: string;
      active: number;
    }>(
      `SELECT id_purchased_package, path, active FROM ${await driveTable()}
        WHERE id_purchased_package IN (?)
        ORDER BY id ASC`,
      [ids]
    );
    for (const r of rows) {
      const id = Number(r.id_purchased_package);
      withRows.add(id);
      if (Number(r.active) === 1) pushPath(map.get(id) ?? [], r.path);
    }
  } catch {
    // Tabla pendiente de migración.
  }

  // Paquetes que NUNCA tuvieron filas en la tabla: se toma la columna vieja
  // (así las carpetas compartidas antes de la migración no desaparecen). Un
  // paquete con filas inactivas NO entra aquí: se le quitó la carpeta.
  const missing = ids.filter((id) => !withRows.has(id));
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
 * Solo las filas SIN paquete: las que traen `id_purchased_package` son
 * carpetas de ese paquete (aunque sean viejas y también traigan `id_user`), y
 * se leen con [packageDrivePaths]. Mezclarlas hacía que una carpeta de
 * paquete saliera como "compartida con el cliente" sin salir en el paquete.
 *
 * Devuelve [] si la migración (columna `id_user`) todavía no se aplicó.
 */
export async function userDrivePaths(userId: number): Promise<string[]> {
  const out: string[] = [];
  if (!userId) return out;
  try {
    const rows = await q<{ path: string }>(
      `SELECT path FROM ${await driveTable()}
        WHERE id_user = ? AND active = 1
          AND id_purchased_package IS NULL
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
      `SELECT id_user, path FROM ${await driveTable()}
        WHERE active = 1 AND id_user IN (?)
          AND id_purchased_package IS NULL
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
