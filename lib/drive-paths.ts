// ==================================================================
// HARD STREET BACKEND - Carpetas del Drive compartidas
// ==================================================================
// El estudio le comparte a cada cliente las carpetas del Drive que quiera y
// el cliente ve SOLO esas carpetas en su Drive.
//
// Desde la migración 2026-10-28 hay UNA sola fuente de acceso:
//
//   users_drive (id, id_user, path, active)
//     -> las carpetas que ve un USUARIO. Sin paquete: el Drive se comparte a
//        la persona, así que da igual desde qué paquete se abra.
//
// La carpeta de CADA paquete vive en `purchased_packages.drive_path` (un
// paquete comparte UNA sola carpeta). Al compartirla se copia a `users_drive`
// de todos los clientes del paquete, y al quitarla se les retira: así una
// carpeta compartida en un paquete SIEMPRE aparece en el Drive del cliente y
// en el diálogo «Carpetas del Drive» de Clientes/Usuarios. Antes la fila
// guardaba `id_purchased_package` y la carpeta del paquete no salía en el
// Drive de la persona.
//
// Reglas (las MISMAS que aplica el panel, app Flutter lib/drive_base.dart):
//
//   * una ruta se normaliza: separador '/', sin barras al principio/final y
//     sin '.' ni '..';
//   * lo ÚNICO que no se puede repetir es LA MISMA carpeta para el mismo
//     usuario (se vería dos veces en su Drive). El UNIQUE (id_user, path) de
//     la tabla lo garantiza también en la base;
//   * dos carpetas DISTINTAS se pueden compartir aunque una esté dentro de
//     otra o compartan padre: `Comercial/RegalandoSonrisas/PrimerServicio` y
//     `Comercial/RegalandoSonrisas/SegundoServicio` son hermanas y no chocan.
// ==================================================================

import { q, exec } from "./db";

/** Tabla con las carpetas que ve cada usuario. */
export const USERS_DRIVE = "users_drive";

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

/**
 * ¿[a] y [b] son LA MISMA carpeta? (sin distinguir mayúsculas: el Drive vive
 * en Windows y `Fiesta`/`fiesta` es la misma carpeta).
 *
 * Es la única condición que impide compartir: dos rutas distintas, aunque una
 * contenga a la otra, son carpetas distintas y el usuario las ve por separado.
 */
export function sameDrivePath(a: string, b: string): boolean {
  const x = normalizeDrivePath(a).toLowerCase();
  const y = normalizeDrivePath(b).toLowerCase();
  return x !== "" && x === y;
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
 * Aviso de que esa carpeta ya se le comparte al usuario (es la misma). Es el
 * único motivo por el que se rechaza compartir una carpeta.
 */
export function duplicateShareReason(shared: string): string {
  const a = normalizeDrivePath(shared);
  if (!a) return "Esa carpeta ya está compartida con el cliente";
  return `«${a}» ya está compartida con este cliente`;
}

/** Acumula una carpeta normalizada sin repetirla. */
function pushPath(out: string[], raw: unknown): void {
  const p = normalizeDrivePath(raw);
  if (p && !out.includes(p)) out.push(p);
}

// ------------------------------------------------------------------
// Carpetas de un PAQUETE (purchased_packages.drive_path)
// ------------------------------------------------------------------

/**
 * Carpetas compartidas de UN paquete comprado. Un paquete comparte UNA sola,
 * así que devuelve [] (nada compartido) o [ruta]. Nunca lanza: si la columna
 * todavía no existe el paquete simplemente no comparte carpeta.
 */
export async function packageDrivePaths(
  purchasedPackageId: number
): Promise<string[]> {
  const out: string[] = [];
  if (!purchasedPackageId) return out;
  try {
    const rows = await q<{ drive_path: string | null }>(
      `SELECT drive_path FROM purchased_packages
        WHERE id = ? AND active = 1`,
      [purchasedPackageId]
    );
    pushPath(out, rows[0]?.drive_path);
  } catch {
    // Sin la columna: sin carpetas.
  }
  return out;
}

/** Versión en lote de [packageDrivePaths] (una sola consulta). */
export async function packageDrivePathsByIds(
  purchasedPackageIds: number[]
): Promise<Map<number, string[]>> {
  const ids = [...new Set(purchasedPackageIds.filter((n) => Number(n) > 0))];
  const map = new Map<number, string[]>();
  for (const id of ids) map.set(id, []);
  if (!ids.length) return map;
  try {
    const rows = await q<{ id: number; drive_path: string | null }>(
      `SELECT id, drive_path FROM purchased_packages WHERE id IN (?)`,
      [ids]
    );
    for (const r of rows) pushPath(map.get(Number(r.id)) ?? [], r.drive_path);
  } catch {
    // Sin columna: sin datos.
  }
  return map;
}

/**
 * Carpetas de los paquetes ACTIVOS de un usuario, indexadas por ruta, con el
 * paquete al que pertenecen. Sirve para etiquetar el Drive del cliente
 * («primer servicio») sin preguntarle a la tabla por paquete.
 */
export async function packageFoldersOfUser(
  userId: number
): Promise<Map<string, { id: number; name: string }>> {
  const out = new Map<string, { id: number; name: string }>();
  if (!userId) return out;
  try {
    const rows = await q<{ id: number; name: string | null; drive_path: string | null }>(
      `SELECT pp.id, pp.name, pp.drive_path
         FROM users_packages up
         JOIN purchased_packages pp
           ON pp.id = up.id_purchased_package AND pp.active = 1
        WHERE up.id_user = ? AND up.active = 1
        ORDER BY up.id ASC`,
      [userId]
    );
    for (const r of rows) {
      const path = normalizeDrivePath(r.drive_path);
      if (!path || out.has(path)) continue;
      out.set(path, { id: Number(r.id), name: String(r.name || "") });
    }
  } catch {
    // Sin datos: el Drive queda sin etiquetas de paquete.
  }
  return out;
}

// ------------------------------------------------------------------
// Carpetas de un USUARIO (users_drive)
// ------------------------------------------------------------------

/**
 * TODAS las carpetas que ve un usuario (las de sus paquetes y las compartidas
 * directamente con él: para su Drive es lo mismo, son suyas).
 *
 * Es la única lectura de `users_drive`: si una carpeta no está aquí (active =
 * 1), el cliente no la ve, aunque un paquete todavía la tenga en `drive_path`.
 * Devuelve [] si la migración todavía no se aplicó.
 */
export async function userDrivePaths(userId: number): Promise<string[]> {
  const out: string[] = [];
  if (!userId) return out;
  try {
    const rows = await q<{ path: string }>(
      `SELECT path FROM ${USERS_DRIVE}
        WHERE id_user = ? AND active = 1
        ORDER BY id ASC`,
      [userId]
    );
    for (const r of rows) pushPath(out, r.path);
  } catch {
    // Migración pendiente: sin carpetas.
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
      `SELECT id_user, path FROM ${USERS_DRIVE}
        WHERE active = 1 AND id_user IN (?)
        ORDER BY id ASC`,
      [ids]
    );
    for (const r of rows) pushPath(map.get(Number(r.id_user)) ?? [], r.path);
  } catch {
    // Migración pendiente.
  }
  return map;
}

/** ¿El usuario [userId] ya tiene compartida ESA MISMA carpeta? */
export async function userSharedConflict(
  userId: number,
  path: string
): Promise<string | null> {
  const target = normalizeDrivePath(path);
  if (!target || !userId) return null;
  for (const other of await userDrivePaths(userId)) {
    if (sameDrivePath(target, other)) return other;
  }
  return null;
}

/**
 * ¿Algún cliente de la compra [purchasedPackageId] ya tiene compartida ESA
 * MISMA carpeta? Cubre tanto otro paquete del cliente como una carpeta
 * compartida directamente con él, porque todo vive en `users_drive`.
 *
 * Solo la misma carpeta cuenta: compartirle a otro paquete una carpeta hermana
 * (o una que esté dentro de otra ya compartida) es legítimo.
 *
 * Devuelve esa carpeta (para poder decirle al usuario cuál es) o null.
 */
export async function sharedDriveConflict(
  purchasedPackageId: number,
  path: string
): Promise<string | null> {
  const target = normalizeDrivePath(path);
  if (!target) return null;
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

// ------------------------------------------------------------------
// Escritura: compartir / dejar de compartir con usuarios
// ------------------------------------------------------------------

/**
 * Deja [path] compartida con [userIds]: crea la fila o REACTIVA la que ya
 * existía (nunca duplica). Lo usan tanto «compartir con el usuario» como
 * «compartir la carpeta del paquete», que es lo mismo desde el punto de vista
 * del cliente.
 */
export async function shareFolderWithUsers(
  userIds: number[],
  path: string
): Promise<void> {
  const clean = normalizeDrivePath(path);
  const ids = [...new Set(userIds.map((n) => Number(n)))].filter((n) => n > 0);
  if (!clean || !ids.length) return;
  for (const id of ids) {
    const rows = await q<{ id: number; active: number }>(
      `SELECT id, active FROM ${USERS_DRIVE}
        WHERE id_user = ? AND path = ?
        ORDER BY active DESC, id DESC LIMIT 1`,
      [id, clean]
    );
    if (rows.length) {
      if (Number(rows[0].active) !== 1) {
        await exec(
          `UPDATE ${USERS_DRIVE} SET active = 1, updated = NOW() WHERE id = ?`,
          [Number(rows[0].id)]
        );
      }
      continue;
    }
    await exec(
      `INSERT INTO ${USERS_DRIVE} (id_user, path) VALUES (?, ?)`,
      [id, clean]
    );
  }
}

/** Deja de compartir [path] con [userIds] (baja lógica). */
export async function unshareFolderFromUsers(
  userIds: number[],
  path: string
): Promise<number> {
  const clean = normalizeDrivePath(path);
  const ids = [...new Set(userIds.map((n) => Number(n)))].filter((n) => n > 0);
  if (!clean || !ids.length) return 0;
  try {
    const r = await exec(
      `UPDATE ${USERS_DRIVE}
          SET active = 0
        WHERE id_user IN (?) AND path = ? AND active = 1`,
      [ids, clean]
    );
    return Number(r.affectedRows || 0);
  } catch {
    return 0;
  }
}

/**
 * Deja sin carpeta a los paquetes de [userIds] que compartían [path].
 *
 * La carpeta del paquete y la del usuario son la MISMA: si se retira desde el
 * Drive del cliente, el paquete no puede seguir diciendo que la comparte (el
 * cliente ya no la vería).
 */
export async function clearPackageFolderForUsers(
  userIds: number[],
  path: string
): Promise<number> {
  const clean = normalizeDrivePath(path);
  const ids = [...new Set(userIds.map((n) => Number(n)))].filter((n) => n > 0);
  if (!clean || !ids.length) return 0;
  try {
    const r = await exec(
      `UPDATE purchased_packages pp
         JOIN users_packages up
           ON up.id_purchased_package = pp.id AND up.active = 1
          SET pp.drive_path = NULL
        WHERE up.id_user IN (?) AND pp.active = 1
          AND pp.drive_path = ?`,
      [ids, clean]
    );
    return Number(r.affectedRows || 0);
  } catch {
    return 0;
  }
}
