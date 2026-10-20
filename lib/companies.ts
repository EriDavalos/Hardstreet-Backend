// ==================================================================
// HARD STREET BACKEND - EMPRESAS (multi-estudio)
// ==================================================================
// Cada empresa es un estudio independiente. Todo lo que se guarda en el
// sistema (clientes, agendas, finanzas, archivos, paquetes, servicios,
// roles, usuarios, sitio web…) pertenece a UNA empresa.
//
// Reglas que viven AQUÍ (el panel solo las refleja):
//
//   * Un usuario pertenece a una sola empresa (`users.id_company`). El rol
//     **Superadmin** es la excepción: no pertenece a ninguna y ve todas.
//   * Cada empresa tiene una CARPETA RAÍZ dentro del Drive del servidor
//     (`DRIVE_ROOT`). Nada de lo que hay por encima de esa carpeta existe
//     para sus usuarios.
//   * Dos empresas NUNCA pueden compartir (ni solapar) carpeta raíz: si no,
//     se verían los archivos entre ellas.
//
// Sin la migración `2026-10-20_empresas.sql` estas funciones devuelven
// valores vacíos en vez de romper el panel.
// ==================================================================

import type { NextApiRequest } from "next";
import { exec, q } from "./db";
import { drivePathsOverlap, normalizeDrivePath } from "./drive-paths";

export const SUPERADMIN_ROLE = "Superadmin";
export const DEFAULT_COMPANY_ID = 1;

export type Company = {
  id: number;
  name: string;
  slug: string;
  /** Carpeta raíz de la empresa DENTRO del Drive del servidor ('' = raíz). */
  folderPath: string;
  color: string;
  active: boolean;
  created: string;
  admins: CompanyAdmin[];
  users: number;
  clients: number;
};

export type CompanyAdmin = {
  id: number;
  name: string;
  email: string;
};

/** ¿La tabla `companies` (y las columnas) ya existen? */
let companiesReady: boolean | null = null;
export async function hasCompanies(): Promise<boolean> {
  if (companiesReady !== null) return companiesReady;
  try {
    await q("SELECT id FROM companies LIMIT 1");
    companiesReady = true;
  } catch {
    companiesReady = false;
  }
  return companiesReady;
}

/**
 * Carpeta raíz de una empresa: SIEMPRE relativa al Drive del servidor.
 *
 * Rechaza rutas absolutas, unidades (`C:`), `..` y nombres ocultos: la
 * carpeta de una empresa no puede escaparse de `DRIVE_ROOT`.
 */
export function normalizeCompanyFolder(path: unknown): string | null {
  const raw = String(path ?? "").trim();
  if (!raw || raw === "/") return "";
  if (/^[A-Za-z]:/.test(raw) || raw.startsWith("/") || raw.startsWith("\\\\")) {
    return null;
  }
  const parts = raw
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (parts.some((s) => s === "." || s === ".." || s.startsWith("."))) {
    return null;
  }
  return normalizeDrivePath(parts.join("/"));
}

/** Nombre legible → slug para la carpeta (`Mi Estudio 2` → `mi-estudio-2`). */
export function slugify(name: string): string {
  const base = String(name ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || "empresa";
}

const norm = (v: unknown) => String(v ?? "").trim();

/** ¿Existe otra empresa con esa carpeta (o dentro de ella)? */
export async function folderTaken(
  folder: string,
  exceptId = 0
): Promise<Company | null> {
  if (!(await hasCompanies())) return null;
  const rows = await q<{ id: number; name: string; folder_path: string }>(
    "SELECT id, name, folder_path FROM companies WHERE active = 1 AND id <> ?",
    [exceptId]
  );
  for (const r of rows) {
    if (drivePathsOverlap(folder, r.folder_path)) {
      return {
        id: Number(r.id),
        name: String(r.name),
        slug: "",
        folderPath: String(r.folder_path ?? ""),
        color: "",
        active: true,
        created: "",
        admins: [],
        users: 0,
        clients: 0,
      };
    }
  }
  return null;
}

/** Todas las empresas con sus administradores y conteos. */
export async function listCompanies(): Promise<Company[]> {
  if (!(await hasCompanies())) return [];
  const rows = await q<{
    id: number;
    name: string;
    slug: string;
    folder_path: string;
    color: string | null;
    active: number;
    created: string;
    users: number;
    clients: number;
  }>(
    `SELECT c.id, c.name, c.slug, c.folder_path, c.color, c.active,
            DATE_FORMAT(c.created, '%Y-%m-%dT%H:%i:%s') AS created,
            (SELECT COUNT(*) FROM users u
              WHERE u.id_company = c.id AND u.active = 1) AS users,
            (SELECT COUNT(*) FROM users u
               JOIN roles r ON r.id = u.id_role
              WHERE u.id_company = c.id AND u.active = 1
                AND LOWER(r.name) = 'cliente') AS clients
       FROM companies c
      ORDER BY c.active DESC, c.id ASC`
  );
  const out: Company[] = [];
  for (const r of rows) {
    out.push({
      id: Number(r.id),
      name: String(r.name ?? ""),
      slug: String(r.slug ?? ""),
      folderPath: String(r.folder_path ?? ""),
      color: String(r.color ?? ""),
      active: Number(r.active) === 1,
      created: String(r.created ?? ""),
      admins: await companyAdmins(Number(r.id)),
      users: Number(r.users) || 0,
      clients: Number(r.clients) || 0,
    });
  }
  return out;
}

/** Administradores (rol Admin) de una empresa. */
export async function companyAdmins(companyId: number): Promise<CompanyAdmin[]> {
  try {
    const rows = await q<{ id: number; name: string | null; lastname: string | null; email: string | null }>(
      `SELECT u.id, u.name, u.lastname, u.email
         FROM users u
         JOIN roles r ON r.id = u.id_role
        WHERE u.active = 1 AND u.id_company = ?
          AND LOWER(r.name) = 'admin'
        ORDER BY u.name ASC`,
      [companyId]
    );
    return rows.map((r) => ({
      id: Number(r.id),
      name: [r.name, r.lastname].filter(Boolean).join(" ").trim(),
      email: String(r.email ?? ""),
    }));
  } catch {
    return [];
  }
}

/** Una empresa (o null). */
export async function getCompany(id: number): Promise<Company | null> {
  if (!(await hasCompanies()) || id <= 0) return null;
  const all = await listCompanies();
  return all.find((c) => c.id === id) ?? null;
}

export type CompanyInput = {
  name: string;
  folderPath: string;
  color?: string | null;
};

/**
 * Crea una empresa. Devuelve su id.
 *
 * [folder] se valida contra el Drive (relativa, sin `..`) y contra las demás
 * empresas (no puede solaparse). Si viene vacía se usa el slug: así nunca
 * queda apuntando a la raíz del Drive por accidente.
 */
export async function createCompany(input: CompanyInput): Promise<number> {
  if (!(await hasCompanies())) throw new Error("Falta aplicar la migración de Empresas");
  const name = norm(input.name).slice(0, 140);
  if (!name) throw new Error("El nombre de la empresa es obligatorio");

  const slug = await uniqueSlug(slugify(name));
  const normalized = normalizeCompanyFolder(input.folderPath || slug);
  if (normalized === null) {
    throw new Error("La carpeta debe ser una ruta RELATIVA dentro del Drive (sin C:, /, .. ni ocultos)");
  }
  const folder = normalized || slug;
  const taken = await folderTaken(folder);
  if (taken) {
    throw new Error(`Esa carpeta ya es de la empresa "${taken.name}"`);
  }

  const res = await exec(
    "INSERT INTO companies (name, slug, folder_path, color, active) VALUES (?, ?, ?, ?, 1)",
    [name, slug, folder, norm(input.color) || null]
  );
  const companyId = Number(res.insertId) || 0;
  if (companyId > 0) await seedRolesForCompany(companyId);
  return companyId;
}

/** Actualiza nombre, carpeta, color o estado. Devuelve true si cambió algo. */
export async function updateCompany(
  id: number,
  patch: { name?: unknown; folderPath?: unknown; color?: unknown; active?: unknown }
): Promise<boolean> {
  if (!(await hasCompanies()) || id <= 0) return false;
  const rows = await q<{ id: number; folder_path: string }>(
    "SELECT id, folder_path FROM companies WHERE id = ? LIMIT 1",
    [id]
  );
  if (!rows.length) return false;

  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    const name = norm(patch.name).slice(0, 140);
    if (!name) throw new Error("El nombre de la empresa es obligatorio");
    sets.push("name = ?");
    values.push(name);
  }
  if (patch.folderPath !== undefined) {
    const folder = normalizeCompanyFolder(patch.folderPath);
    if (folder === null) {
      throw new Error("La carpeta debe ser una ruta RELATIVA dentro del Drive (sin C:, /, .. ni ocultos)");
    }
    // La RAÍZ del Drive es solo del Superadministrador: ninguna otra empresa
    // puede apuntar a ella (vería TODO lo de las demás).
    if (folder === "" && id !== DEFAULT_COMPANY_ID) {
      throw new Error(
        "La raíz del Drive es solo del Superadministrador: asigna una subcarpeta a esta empresa"
      );
    }
    const taken = await folderTaken(folder, id);
    if (taken) throw new Error(`Esa carpeta ya es de la empresa "${taken.name}"`);
    sets.push("folder_path = ?");
    values.push(folder);
  }
  if (patch.color !== undefined) {
    sets.push("color = ?");
    values.push(norm(patch.color) || null);
  }
  if (patch.active !== undefined) {
    sets.push("active = ?");
    values.push(patch.active === false || Number(patch.active) === 0 ? 0 : 1);
  }
  if (!sets.length) return false;
  values.push(id);
  await exec(`UPDATE companies SET ${sets.join(", ")} WHERE id = ?`, values);
  return true;
}

/** ¿El rol es el Superadministrador del sistema? */
export async function isSuperAdminRole(roleId: number | null): Promise<boolean> {
  if (!roleId) return false;
  try {
    const rows = await q<{ id: number }>(
      "SELECT id FROM roles WHERE id = ? AND LOWER(name) = ? AND active = 1 LIMIT 1",
      [roleId, SUPERADMIN_ROLE.toLowerCase()]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Empresa del usuario (null para el Superadmin o si la migración falta). */
export async function userCompanyId(userId: number): Promise<number | null> {
  try {
    const rows = await q<{ id_company: number | null }>(
      "SELECT id_company FROM users WHERE id = ? LIMIT 1",
      [userId]
    );
    const v = rows[0]?.id_company;
    return v === null || v === undefined ? null : Number(v) || null;
  } catch {
    // Migración pendiente: todos son de la empresa 1 (Hardstreet).
    return DEFAULT_COMPANY_ID;
  }
}

/**
 * Empresa ACTIVA de la petición.
 *
 * * Un usuario normal trabaja SIEMPRE en la suya (el header se ignora: no
 *   puede pedir la de otra empresa).
 * * El Superadmin elige con qué empresa trabaja con `X-Company-Id`; sin
 *   header va sin empresa (null = "todas", solo válido para él).
 */
export function requestedCompanyHeader(req: NextApiRequest): number | null {
  const raw = req.headers["x-company-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(String(value ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Crea los roles base de una empresa nueva (Admin, Cliente, Colaborador y
 * Empleado) para que pueda usarse de inmediato. El Admin nace con TODOS los
 * permisos; los demás quedan sin permisos para que el estudio los ajuste.
 */
export async function seedRolesForCompany(companyId: number): Promise<void> {
  if (companyId <= 0) return;
  const bases = ["Admin", "Cliente", "Colaborador", "Empleado"];
  for (const name of bases) {
    const exists = await q<{ id: number }>(
      "SELECT id FROM roles WHERE id_company = ? AND LOWER(name) = LOWER(?) LIMIT 1",
      [companyId, name]
    );
    if (exists.length) continue;
    const res = await exec("INSERT INTO roles (name, id_company, active) VALUES (?, ?, 1)", [
      name,
      companyId,
    ]);
    const roleId = Number(res.insertId) || 0;
    if (name === "Admin" && roleId > 0) {
      await exec(
        `INSERT INTO permissions_roles (id_modules, id_permission, id_role, active)
         SELECT m.id, p.id, ?, 1
           FROM modules m CROSS JOIN permissions p
          WHERE m.active = 1 AND p.active = 1`,
        [roleId]
      );
    }
  }
}

/** Slug libre (`mi-estudio`, `mi-estudio-2`…). */
async function uniqueSlug(base: string): Promise<string> {
  let candidate = base;
  for (let i = 2; i < 100; i++) {
    const rows = await q<{ id: number }>(
      "SELECT id FROM companies WHERE LOWER(slug) = LOWER(?) LIMIT 1",
      [candidate]
    );
    if (!rows.length) return candidate;
    candidate = `${base}-${i}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}
