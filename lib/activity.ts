// ==================================================================
// HARD STREET BACKEND - Bitácora de actividad (auditoría)
// ==================================================================
// Registra QUIÉN creó, editó o eliminó cada cosa que se puede agregar o
// eliminar. Cada endpoint de escritura llama a `logActivity()` después de
// que la operación salió bien.
//
// Guarda el usuario en el momento de la acción (nombre y rol desnormalizados)
// para que la bitácora siga siendo legible aunque el usuario se edite o se
// dé de baja después. Nunca lanza: una bitácora caída no puede tumbar la
// operación (si falta la migración, solo se registra en consola).
// ==================================================================
import type { NextApiRequest } from "next";
import { q, exec } from "./db";

export type ActivityAction = "create" | "update" | "delete";

export interface ActivityInput {
  /** Id del usuario que ejecuta la acción (sesión). */
  userId?: number | null;
  /** Clave del módulo en la BD (`modules.module`). */
  module?: string | null;
  /** Nombre visible del módulo (`modules.name`). */
  moduleName?: string | null;
  action: ActivityAction;
  /** Qué se tocó: "cliente", "usuario", "rol", "agenda"... */
  entity: string;
  /** Id del registro afectado. */
  entityId?: number | null;
  /** Texto humano ("Cliente creado exitosamente"). */
  description?: string | null;
  /** Datos extra (se guardan como JSON). */
  details?: unknown;
  /** Para guardar la IP de origen. */
  req?: NextApiRequest;
  /** Empresa de la acción (si no viene, la del usuario que la ejecuta). */
  companyId?: number | null;
}

/** IP de origen (detrás de proxy usa la primera de x-forwarded-for). */
function ipOf(req?: NextApiRequest): string | null {
  if (!req) return null;
  const fwd = req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  const first = String(raw || "").split(",")[0].trim();
  return first || req.socket?.remoteAddress || null;
}

/** Guarda una entrada de la bitácora. Nunca lanza. */
export async function logActivity(input: ActivityInput): Promise<void> {
  try {
    const id = Number(input.userId || 0) || null;
    let userName: string | null = null;
    let roleName: string | null = null;
    let companyId = Number(input.companyId || 0) || null;
    if (id) {
      type Who = {
        name: string | null;
        lastname: string | null;
        role_name: string | null;
        id_company?: number | null;
      };
      let rows: Who[];
      try {
        rows = await q<Who>(
          `SELECT u.name, u.lastname, r.name AS role_name, u.id_company
             FROM users u
             LEFT JOIN roles r ON r.id = u.id_role
            WHERE u.id = ?
            LIMIT 1`,
          [id]
        );
      } catch {
        // Migración de Empresas pendiente: se registra sin empresa.
        rows = await q<Who>(
          `SELECT u.name, u.lastname, r.name AS role_name
             FROM users u
             LEFT JOIN roles r ON r.id = u.id_role
            WHERE u.id = ?
            LIMIT 1`,
          [id]
        );
      }
      if (rows.length) {
        userName =
          `${rows[0].name ?? ""} ${rows[0].lastname ?? ""}`.trim() || null;
        roleName = rows[0].role_name ?? null;
        // Si el endpoint no dijo la empresa, se usa la del usuario (el
        // Superadmin no tiene: escribe con la empresa de la petición).
        companyId = companyId ?? (Number(rows[0].id_company || 0) || null);
      }
    }
    const values = [
      id,
      userName,
      roleName,
      input.module ?? null,
      input.moduleName ?? null,
      input.action,
      input.entity,
      input.entityId ?? null,
      input.description ?? null,
      input.details === undefined ? null : JSON.stringify(input.details),
      ipOf(input.req),
    ];
    try {
      await exec(
        `INSERT INTO activity_log
           (id_user, user_name, role_name, module, module_name, action,
            entity, entity_id, description, details, ip, id_company)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [...values, companyId]
      );
    } catch {
      // Migración de Empresas pendiente: la bitácora funciona igual.
      await exec(
        `INSERT INTO activity_log
           (id_user, user_name, role_name, module, module_name, action,
            entity, entity_id, description, details, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        values
      );
    }
  } catch (e) {
    // Sin migración aplicada la bitácora no existe: se avisa y se sigue.
    console.error("[activity]", e);
  }
}
