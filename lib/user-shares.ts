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

/**
 * Qué puede hacer un DESTINATARIO en una carpeta compartida.
 *
 * Los decide quien COMPARTE (no el rol): la misma persona puede editar una
 * carpeta y solo ver otra. El dueño siempre puede todo.
 */
export interface SharePermissions {
  /** Ver el contenido. */
  view: boolean;
  /** Editar: renombrar, mover y eliminar. */
  edit: boolean;
  /** Crear: subir archivos y carpetas. */
  create: boolean;
  /** Descargar archivos y carpetas (ZIP). */
  download: boolean;
}

/** Permisos de un compartido NUEVO: ver y descargar (como era antes). */
export const SHARE_PERMISSIONS_DEFAULT: SharePermissions = {
  view: true,
  edit: false,
  create: false,
  download: true,
};

/** ¿[v] es un "sí"? (acepta true, 1, "1", "true"). */
function yes(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (s === "1" || s === "true" || s === "si" || s === "sí") return true;
  if (s === "0" || s === "false" || s === "no") return false;
  return fallback;
}

/** Normaliza permisos que llegan de la API (objeto, booleanos o 0/1). */
export function normalizePermissions(
  raw: unknown,
  fallback: SharePermissions = SHARE_PERMISSIONS_DEFAULT
): SharePermissions {
  const m = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  return {
    view: yes(m.view ?? m.ver, fallback.view),
    edit: yes(m.edit ?? m.editar, fallback.edit),
    create: yes(m.create ?? m.crear, fallback.create),
    download: yes(m.download ?? m.descargar, fallback.download),
  };
}

/** ¿[a] y [b] conceden LO MISMO? */
export function samePermissions(
  a: SharePermissions,
  b: SharePermissions
): boolean {
  return (
    a.view === b.view &&
    a.edit === b.edit &&
    a.create === b.create &&
    a.download === b.download
  );
}

/** Permisos guardados en una fila (columnas ausentes = compartido viejo). */
export function permissionsOfRow(row: Record<string, unknown>): SharePermissions {
  return {
    view: yes(row.can_view, true),
    edit: yes(row.can_edit, false),
    create: yes(row.can_create, false),
    download: yes(row.can_download, true),
  };
}

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
  /** Lo que puede hacer el destinatario (el dueño siempre puede todo). */
  permissions: SharePermissions;
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
  /**
   * Lo que YO puedo hacer, sumando a todos los dueños: si uno me dio
   * "Editar" y otro solo "Ver", la carpeta se puede editar (es el mismo
   * contenido).
   */
  permissions: SharePermissions;
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
    // Las columnas de permisos pueden no existir todavía (migración
    // pendiente): en ese caso se consulta como antes y todo queda en
    // "ver y descargar", que es el comportamiento de siempre.
    let rows: Record<string, unknown>[];
    try {
      rows = await q<Record<string, unknown>>(
        `SELECT id, id_owner, id_target, path, created,
                can_view, can_edit, can_create, can_download
           FROM user_drive_shares
          WHERE active = 1 AND id_owner = ?
            ${target ? "AND path = ?" : ""}
          ORDER BY path ASC, id ASC`,
        target ? [ownerId, target] : [ownerId]
      );
    } catch {
      rows = await q<Record<string, unknown>>(
        `SELECT id, id_owner, id_target, path, created
           FROM user_drive_shares
          WHERE active = 1 AND id_owner = ?
            ${target ? "AND path = ?" : ""}
          ORDER BY path ASC, id ASC`,
        target ? [ownerId, target] : [ownerId]
      );
    }
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
      permissions: permissionsOfRow(r),
      created: (r.created as string | null) ?? null,
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
    let rows: Record<string, unknown>[];
    try {
      rows = await q<Record<string, unknown>>(
        `SELECT id, id_owner, path, can_view, can_edit, can_create, can_download
           FROM user_drive_shares
          WHERE active = 1 AND id_target = ?
          ORDER BY path ASC, id ASC`,
        [targetId]
      );
    } catch {
      rows = await q<Record<string, unknown>>(
        `SELECT id, id_owner, path FROM user_drive_shares
          WHERE active = 1 AND id_target = ?
          ORDER BY path ASC, id ASC`,
        [targetId]
      );
    }
    const names = await userNames(rows.map((r) => Number(r.id_owner)));
    const byPath = new Map<string, SharedFolder>();
    for (const r of rows) {
      const p = clean(r.path);
      if (!p) continue;
      const perms = permissionsOfRow(r);
      const entry = byPath.get(p) ?? {
        shareId: Number(r.id),
        path: p,
        local: isLocalPath(p),
        owners: [],
        permissions: { ...perms },
      };
      const ownerId = Number(r.id_owner);
      if (!entry.owners.some((o) => o.id === ownerId)) {
        entry.owners.push({ id: ownerId, name: names.get(ownerId) ?? "" });
      }
      // Union: si CUALQUIER dueño me dio un permiso, lo tengo (es el mismo
      // contenido y no se puede partir en dos).
      entry.permissions = {
        view: entry.permissions.view || perms.view,
        edit: entry.permissions.edit || perms.edit,
        create: entry.permissions.create || perms.create,
        download: entry.permissions.download || perms.download,
      };
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

/** Resultado de compartir: cuántos quedaron, cuántos ya estaban y qué falló. */
export interface ShareOutcome {
  shared: number;
  already: number;
  /** Ya la tenían, pero se le cambiaron los permisos. */
  updated: number;
  conflicts: string[];
  /**
   * Motivos por los que NO se pudo guardar un destinatario (tabla sin migrar,
   * usuario inexistente, la base rechazó la fila…).
   *
   * Sin esto, un INSERT que falla se reportaba como "Sin cambios" y el panel
   * decía que la carpeta quedó compartida cuando en realidad NADIE recibió
   * nada: el otro usuario veía "no existe o ya no está compartida".
   */
  errors: string[];
}

/** Traduce un error de guardado a algo que se pueda leer en el panel. */
function saveErrorReason(e: unknown): string {
  const err = e as { code?: string; message?: string };
  const code = String(err?.code || "");
  if (code === "ER_NO_SUCH_TABLE" || code === "ER_BAD_FIELD_ERROR") {
    return `${code}: falta aplicar la migración de user_drive_shares`;
  }
  if (code === "ER_NO_REFERENCED_ROW_2") {
    return "ER_NO_REFERENCED_ROW_2: el usuario destinatario ya no existe";
  }
  return `${code || "error"}: ${err?.message || "no se pudo guardar el compartido"}`;
}

/**
 * Comparte [path] con [targetIds]. Devuelve cuántos quedaron, los que ya
 * estaban (para poder decirlo en el mensaje) y los que FALLARON.
 */
export async function sharePathWith(
  ownerId: number,
  targetIds: number[],
  path: string,
  /** Permisos para TODOS, o uno por destinatario. */
  permissions:
    | SharePermissions
    | Map<number, SharePermissions>
    | Record<number, SharePermissions> = SHARE_PERMISSIONS_DEFAULT
): Promise<ShareOutcome> {
  const p = clean(path);
  if (!ownerId || !p) {
    return { shared: 0, already: 0, updated: 0, conflicts: [], errors: [] };
  }

  // Nadie se comparte a sí mismo.
  const targets = [...new Set(targetIds.map((n) => Number(n)))].filter(
    (n) => n > 0 && n !== ownerId
  );
  if (!targets.length) {
    return { shared: 0, already: 0, updated: 0, conflicts: [], errors: [] };
  }

  /** Permisos que tocan a [target]. */
  const permsFor = (target: number): SharePermissions => {
    if (permissions instanceof Map) {
      return permissions.get(target) ?? SHARE_PERMISSIONS_DEFAULT;
    }
    if ("view" in permissions) return permissions as SharePermissions;
    const rec = permissions as Record<number, SharePermissions>;
    return rec[target] ?? SHARE_PERMISSIONS_DEFAULT;
  };

  // Lo que ya está compartido, para actualizar permisos sin duplicar.
  const existing = new Map<number, UserShare>();
  for (const s of await sharesByOwner(ownerId, p)) {
    existing.set(s.targetId, s);
  }

  let shared = 0;
  let already = 0;
  let updated = 0;
  const conflicts: string[] = [];
  const errors: string[] = [];
  for (const target of targets) {
    try {
      // Ya tiene (él) una carpeta que se solapa: no se le agrega nada.
      const clash = await targetConflict(target, p);
      if (clash && clash !== p) {
        conflicts.push(clash);
        continue;
      }
      const perm = normalizePermissions(permsFor(target));
      const had = existing.get(target);
      if (had) {
        if (samePermissions(had.permissions, perm)) {
          already++;
          continue;
        }
        // Ya la tenía: solo se CAMBIAN sus permisos (nunca se duplica).
        const res = await exec(
          `UPDATE user_drive_shares
              SET can_view = ?, can_edit = ?, can_create = ?,
                  can_download = ?, active = 1, updated = NOW()
            WHERE active = 1 AND id_owner = ? AND id_target = ? AND path = ?`,
          [
            perm.view ? 1 : 0,
            perm.edit ? 1 : 0,
            perm.create ? 1 : 0,
            perm.download ? 1 : 0,
            ownerId,
            target,
            p,
          ]
        );
        if (res.affectedRows > 0) updated++;
        else already++;
        continue;
      }
      await exec(
        `INSERT INTO user_drive_shares
           (id_owner, id_target, path, can_view, can_edit, can_create, can_download)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE active = 1, updated = NOW(),
           can_view = VALUES(can_view), can_edit = VALUES(can_edit),
           can_create = VALUES(can_create), can_download = VALUES(can_download)`,
        [
          ownerId,
          target,
          p,
          perm.view ? 1 : 0,
          perm.edit ? 1 : 0,
          perm.create ? 1 : 0,
          perm.download ? 1 : 0,
        ]
      );
      shared++;
    } catch (e) {
      // Se guarda el MOTIVO (en vez de ignorarlo): quien comparte tiene que
      // saber que ese destinatario no quedó, y por qué.
      errors.push(saveErrorReason(e));
    }
  }
  return { shared, already, updated, conflicts, errors };
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
/**
 * Usuarios con los que se puede compartir.
 *
 * Solo los de MI MISMA empresa: compartir una carpeta con alguien de otro
 * estudio expondría archivos entre empresas, justo lo que la separación
 * evita.
 */
export async function shareCandidates(
  excludeId: number,
  companyId?: number | null
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
          ${companyId ? "AND u.id_company = ?" : ""}
        ORDER BY u.name ASC, u.lastname ASC, u.id ASC`,
      companyId ? [excludeId, companyId] : [excludeId]
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
