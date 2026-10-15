// ==================================================================
// HARD STREET BACKEND - Archivos compartidos entre USUARIOS
// ==================================================================
// Un usuario comparte UNA carpeta de SU Drive con OTROS usuarios (uno o
// varios). Es independiente del Drive de los paquetes:
//
//   purchased_packages_drive  -> el estudio comparte al CLIENTE de un paquete
//   user_drive_shares         -> cualquier usuario comparte SU carpeta
//                                (colaborador <-> colaborador, etc.)
//
// Reglas que se aplican aquí (y que el panel replica antes de ofrecer algo):
//   * nadie se comparte a sí mismo;
//   * dos usuarios no pueden tener la MISMA carpeta dos veces (UNIQUE);
//   * tampoco carpetas que se SOLAPEN (una dentro de la otra): el drive
//     mostraría el mismo contenido dos veces;
//   * quitar un compartido es BAJA LÓGICA (active = 0), así el historial
//     queda y se puede volver a compartir sin duplicar filas.
//
// Todas las consultas son TOLERANTES: si la migración todavía no se aplicó,
// devuelven listas vacías en vez de romper la petición.
// ==================================================================

import { q, exec } from "./db";
import {
  normalizeSharePath,
  pathsOverlap,
  isLocalPath,
} from "./drive-paths";

/** Una carpeta compartida con su dueño y con quién la recibe. */
export interface UserShare {
  id: number;
  ownerId: number;
  ownerName: string;
  targetId: number;
  targetName: string;
  path: string;
  /** ¿Es una CARPETA LOCAL de la computadora del dueño? */
  local: boolean;
  created: string | null;
}

/** Nombres de los usuarios que comparten una carpeta con [viewerId]. */
export interface SharedFolder {
  /** Id del compartido (el primero de esa carpeta): lo usa la app para abrir
   * una carpeta LOCAL con los endpoints /api/local/* del servidor del drive. */
  shareId: number;
  path: string;
  /** ¿Es una CARPETA LOCAL de la computadora del que comparte? */
  local: boolean;
  owners: { id: number; name: string }[];
}

/** Normaliza una ruta del Drive o una ruta LOCAL absoluta. */
const clean = (v: unknown) => normalizeSharePath(v);

/** Nombre visible de un usuario ("Nombre Apellido"), o su correo. */
async function userNames(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const unique = [...new Set(ids.filter((n) => Number(n) > 0))];
  if (!unique.length) return out;
  try {
    const rows = await q<{ id: number; name: string; lastname: string; email: string }>(
      `SELECT id, name, lastname, email FROM users WHERE id IN (?)`,
      [unique]
    );
    for (const r of rows) {
      const full = `${r.name ?? ""} ${r.lastname ?? ""}`.trim();
      out.set(Number(r.id), full || String(r.email || ""));
    }
  } catch {
    // Sin tabla de usuarios (no debería pasar): sin nombres.
  }
  return out;
}

/**
 * Carpetas que YO compartí, con los usuarios que las reciben.
 * `path` vacío en la petición -> todas.
 */
export async function sharesByOwner(
  ownerId: number,
  path = ""
): Promise<UserShare[]> {
  if (!ownerId) return [];
  const target = clean(path);
  try {
    const rows = await q<{
      id: number;
      id_owner: number;
      id_target: number;
      path: string;
      created: string | null;
    }>(
      `SELECT id, id_owner, id_target, path, created
         FROM user_drive_shares
        WHERE active = 1 AND id_owner = ?
          ${target ? "AND path = ?" : ""}
        ORDER BY path ASC, id ASC`,
      target ? [ownerId, target] : [ownerId]
    );
    const names = await userNames([
      ...rows.map((r) => Number(r.id_owner)),
      ...rows.map((r) => Number(r.id_target)),
    ]);
    return rows.map((r) => ({
      id: Number(r.id),
      ownerId: Number(r.id_owner),
      ownerName: names.get(Number(r.id_owner)) ?? "",
      targetId: Number(r.id_target),
      targetName: names.get(Number(r.id_target)) ?? "",
      path: clean(r.path),
      local: isLocalPath(clean(r.path)),
      created: r.created ?? null,
    }));
  } catch {
    // Migración pendiente: sin compartidos.
    return [];
  }
}

/** Compartidos que YO recibí, agrupados por carpeta (con sus dueños). */
export async function sharesByTarget(targetId: number): Promise<SharedFolder[]> {
  if (!targetId) return [];
  try {
    const rows = await q<{ id: number; id_owner: number; path: string }>(
      `SELECT id, id_owner, path FROM user_drive_shares
        WHERE active = 1 AND id_target = ?
        ORDER BY path ASC, id ASC`,
      [targetId]
    );
    const names = await userNames(rows.map((r) => Number(r.id_owner)));
    const byPath = new Map<string, SharedFolder>();
    for (const r of rows) {
      const p = clean(r.path);
      if (!p) continue;
      const entry = byPath.get(p) ?? {
        shareId: Number(r.id),
        path: p,
        local: isLocalPath(p),
        owners: [],
      };
      const ownerId = Number(r.id_owner);
      if (!entry.owners.some((o) => o.id === ownerId)) {
        entry.owners.push({ id: ownerId, name: names.get(ownerId) ?? "" });
      }
      byPath.set(p, entry);
    }
    return [...byPath.values()];
  } catch {
    // Migración pendiente: sin compartidos.
    return [];
  }
}

/** ¿[userId] ya tiene compartida (recibida) una carpeta que se solapa con [path]? */
export async function targetConflict(
  targetId: number,
  path: string
): Promise<string | null> {
  const target = clean(path);
  if (!target || !targetId) return null;
  for (const f of await sharesByTarget(targetId)) {
    if (pathsOverlap(target, f.path)) return f.path;
  }
  return null;
}

/** ¿YO ya compartí una carpeta que se solapa con [path]? */
export async function ownerConflict(
  ownerId: number,
  path: string
): Promise<string | null> {
  const target = clean(path);
  if (!target || !ownerId) return null;
  for (const s of await sharesByOwner(ownerId)) {
    if (pathsOverlap(target, s.path)) return s.path;
  }
  return null;
}

/** ¿Compartí esta carpeta EXACTAMENTE con [targetId]? */
export async function alreadySharedWith(
  ownerId: number,
  targetId: number,
  path: string
): Promise<boolean> {
  const p = clean(path);
  if (!p) return false;
  const mine = await sharesByOwner(ownerId, p);
  return mine.some((s) => s.targetId === targetId);
}

/**
 * Comparte [path] con [targetIds]. Devuelve cuántos quedaron y los que ya
 * estaban (para poder decirlo en el mensaje).
 */
export async function sharePathWith(
  ownerId: number,
  targetIds: number[],
  path: string
): Promise<{ shared: number; already: number; conflicts: string[] }> {
  const p = clean(path);
  if (!ownerId || !p) return { shared: 0, already: 0, conflicts: [] };

  // Nadie se comparte a sí mismo.
  const targets = [...new Set(targetIds.map((n) => Number(n)))].filter(
    (n) => n > 0 && n !== ownerId
  );
  if (!targets.length) return { shared: 0, already: 0, conflicts: [] };

  let shared = 0;
  let already = 0;
  const conflicts: string[] = [];
  for (const target of targets) {
    try {
      // Ya tiene (él) una carpeta que se solapa: no se le agrega nada.
      const clash = await targetConflict(target, p);
      if (clash && clash !== p) {
        conflicts.push(clash);
        continue;
      }
      if (await alreadySharedWith(ownerId, target, p)) {
        already++;
        continue;
      }
      await exec(
        `INSERT INTO user_drive_shares (id_owner, id_target, path)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE active = 1, updated = NOW()`,
        [ownerId, target, p]
      );
      shared++;
    } catch {
      // Sin migración (o usuario inexistente): se ignora ese destinatario.
    }
  }
  return { shared, already, conflicts };
}

/** Deja de compartir [path] con [targetIds] (baja lógica). */
export async function unsharePathWith(
  ownerId: number,
  targetIds: number[],
  path: string
): Promise<number> {
  const p = clean(path);
  if (!ownerId || !p) return 0;
  const targets = [...new Set(targetIds.map((n) => Number(n)))].filter(
    (n) => n > 0
  );
  if (!targets.length) return 0;
  try {
    const res = await exec(
      `UPDATE user_drive_shares SET active = 0
        WHERE active = 1 AND id_owner = ? AND path = ? AND id_target IN (?)`,
      [ownerId, p, targets]
    );
    return res.affectedRows;
  } catch {
    return 0;
  }
}

/** Nombres de los usuarios que pueden compartir (destinatarios posibles). */
export async function shareCandidates(
  excludeId: number
): Promise<{ id: number; name: string; email: string; role: string }[]> {
  try {
    const rows = await q<{
      id: number;
      name: string;
      lastname: string;
      email: string;
      role_name: string | null;
    }>(
      `SELECT u.id, u.name, u.lastname, u.email, r.name AS role_name
         FROM users u
         LEFT JOIN roles r ON r.id = u.id_role AND r.active = 1
        WHERE u.active = 1 AND u.id <> ?
        ORDER BY u.name ASC, u.lastname ASC, u.id ASC`,
      [excludeId]
    );
    return rows.map((r) => ({
      id: Number(r.id),
      name: `${r.name ?? ""} ${r.lastname ?? ""}`.trim() || String(r.email || ""),
      email: String(r.email || ""),
      role: String(r.role_name || ""),
    }));
  } catch {
    return [];
  }
}
