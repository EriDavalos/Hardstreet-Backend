// ==================================================================
// HARD STREET BACKEND - Alcance por EMPRESA
// ==================================================================
// Cada empresa es un estudio independiente: sus usuarios, roles, clientes,
// agendas, finanzas, impresiones, actividad, archivos compartidos, paquetes,
// servicios y sitio web son SOLO suyos.
//
// Este helper resuelve, para cada petición, con qué empresa se trabaja:
//
//   * Usuario normal -> SIEMPRE la suya (`users.id_company`). El header
//     `X-Company-Id` se ignora: no puede pedir la de otra empresa.
//   * Superadmin    -> la que elija con `X-Company-Id`. Sin header ve TODAS
//     (companyId = null) y trabaja en la principal al crear.
//
// Los endpoints suman `scopeFilter(scope)` a su WHERE y sellan cada fila
// nueva con `scope.writeCompanyId`. Nunca se interpola el id en el SQL.
// ==================================================================

import type { NextApiRequest } from "next";
import { q } from "./db";
import {
  DEFAULT_COMPANY_ID,
  isSuperAdminRole,
  requestedCompanyHeader,
  userCompanyId,
} from "./companies";

export type CompanyScope = {
  /** ¿Es el Superadministrador del sistema? */
  isSuper: boolean;
  /** Empresa de la petición; `null` = todas (solo el Superadmin). */
  companyId: number | null;
  /** Empresa donde se CREAN las filas nuevas (nunca null). */
  writeCompanyId: number;
  /** Nombre de la empresa (vacío si ve todas). */
  companyName: string;
  /** Carpeta raíz de la empresa dentro del Drive ('' = raíz). */
  folderPath: string;
  /** ¿La empresa existe y está activa? */
  active: boolean;
};

/** Nombre + carpeta + estado de una empresa (o valores neutros). */
async function companyInfo(
  id: number
): Promise<{ name: string; folderPath: string; active: boolean }> {
  try {
    const rows = await q<{ name: string | null; folder_path: string | null; active: number }>(
      "SELECT name, folder_path, active FROM companies WHERE id = ? LIMIT 1",
      [id]
    );
    if (!rows.length) return { name: "", folderPath: "", active: true };
    return {
      name: String(rows[0].name ?? ""),
      folderPath: String(rows[0].folder_path ?? ""),
      active: Number(rows[0].active) !== 0,
    };
  } catch {
    // Migración de Empresas pendiente: todo pertenece a la empresa principal.
    return { name: "", folderPath: "", active: true };
  }
}

/** Rol y empresa del usuario de la sesión. */
async function userCompany(userId: number): Promise<{
  roleId: number | null;
  companyId: number;
}> {
  try {
    const rows = await q<{ id_role: number | null; id_company: number | null }>(
      "SELECT id_role, id_company FROM users WHERE id = ? AND active = 1 LIMIT 1",
      [userId]
    );
    const row = rows[0];
    if (!row) return { roleId: null, companyId: DEFAULT_COMPANY_ID };
    return {
      roleId: row.id_role === null || row.id_role === undefined ? null : Number(row.id_role),
      companyId: Number(row.id_company) || DEFAULT_COMPANY_ID,
    };
  } catch {
    // Sin la migración `users.id_company` no se puede separar nada.
    return { roleId: null, companyId: DEFAULT_COMPANY_ID };
  }
}

/**
 * Empresa con la que se trabaja en esta petición.
 * [me.sub] es el usuario de la sesión (ya validado por requirePermission).
 */
export async function requestScope(
  req: NextApiRequest,
  me: { sub: number }
): Promise<CompanyScope> {
  const { roleId, companyId: ownCompanyId } = await userCompany(me.sub);
  const isSuper = await isSuperAdminRole(roleId);

  if (isSuper) {
    const chosen = requestedCompanyHeader(req);
    const info = await companyInfo(chosen ?? DEFAULT_COMPANY_ID);
    return {
      isSuper,
      companyId: chosen,
      writeCompanyId: chosen ?? DEFAULT_COMPANY_ID,
      companyName: chosen === null ? "" : info.name,
      folderPath: chosen === null ? "" : info.folderPath,
      active: true,
    };
  }

  const info = await companyInfo(ownCompanyId);
  return {
    isSuper,
    companyId: ownCompanyId,
    writeCompanyId: ownCompanyId,
    companyName: info.name,
    folderPath: info.folderPath,
    active: info.active,
  };
}

/**
 * Condición SQL para recortar por empresa.
 *
 * Devuelve `1 = 1` (sin parámetros) cuando el Superadmin ve todas, para que
 * el endpoint no tenga que ramificar su WHERE.
 */
export function scopeFilter(
  scope: CompanyScope,
  column = "id_company"
): { sql: string; params: number[] } {
  if (scope.companyId === null) return { sql: "1 = 1", params: [] };
  return { sql: `${column} = ?`, params: [scope.companyId] };
}

/** Igual que [scopeFilter] pero para consultas con alias (`u.id_company`). */
export function scopeFilterOn(
  scope: CompanyScope,
  table: string
): { sql: string; params: number[] } {
  return scopeFilter(scope, `${table}.id_company`);
}

/**
 * ¿El usuario pertenece a una empresa DESACTIVADA?
 * Se consulta al abrir la sesión: sus datos siguen guardados, pero no entra
 * hasta que el Superadministrador reactive la empresa. El Superadmin nunca
 * queda bloqueado.
 */
export async function companyDisabledFor(userId: number): Promise<boolean> {
  try {
    const { roleId } = await userCompany(userId);
    if (await isSuperAdminRole(roleId)) return false;
    const companyId = await userCompanyId(userId);
    if (!companyId) return false;
    const info = await companyInfo(companyId);
    return !info.active;
  } catch {
    return false;
  }
}
