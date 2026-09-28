// ==================================================================
// HARD STREET BACKEND - Login de usuarios
// ==================================================================
import { q } from "./db";
import { UserRow, RoleRow } from "./mappers";

export interface LoginUserRow extends UserRow { password: string | null; }

export async function getUserByEmailWithRole(email: string): Promise<(LoginUserRow & { role_name: string | null }) | null> {
  const rows = await q<LoginUserRow & { role_name: string | null }>(
    `SELECT u.id, u.name, u.lastname, u.number, u.email, u.password, u.id_role,
            r.name AS role_name
       FROM users u
       LEFT JOIN roles r ON r.id = u.id_role
      WHERE u.active = 1 AND LOWER(u.email) = LOWER(?)
      LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

export type { RoleRow };
