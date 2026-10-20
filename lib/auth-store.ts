// ==================================================================
// HARD STREET BACKEND - Login de usuarios
// ==================================================================
import { q } from "./db";
import { UserRow, RoleRow } from "./mappers";

export interface LoginUserRow extends UserRow {
  password: string | null;
  /** Empresa del usuario (NULL en el Superadministrador). */
  id_company: number | null;
  company_name?: string | null;
}

export async function getUserByEmailWithRole(
  email: string
): Promise<
  | (LoginUserRow & {
      role_name: string | null;
      id_company: number | null;
      company_name: string | null;
    })
  | null
> {
  const rows = await q<
    LoginUserRow & {
      role_name: string | null;
      id_company: number | null;
      company_name: string | null;
    }
  >(
    `SELECT u.id, u.name, u.lastname, u.number, u.email, u.password, u.id_role,
            u.id_company,
            r.name AS role_name,
            c.name AS company_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.id_role
       LEFT JOIN companies c ON c.id = u.id_company AND c.active = 1
      WHERE u.active = 1 AND LOWER(u.email) = LOWER(?)
      LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

export type { RoleRow };
