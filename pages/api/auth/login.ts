import type { NextApiRequest, NextApiResponse } from "next";
import bcrypt from "bcryptjs";
import { withCors } from "../../../lib/cors";
import { createSessionToken } from "../../../lib/auth";
import { getUserByEmailWithRole } from "../../../lib/auth-store";
import { mapUser } from "../../../lib/mappers";

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Metodo no permitido" });
    return;
  }

  const { email, password } = (req.body || {}) as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "Email y contrasena son obligatorios" });
    return;
  }

  const user = await getUserByEmailWithRole(String(email));
  if (!user || !user.password) {
    res.status(401).json({ error: "Credenciales invalidas" });
    return;
  }

  const ok = await bcrypt.compare(String(password), user.password);
  if (!ok) {
    res.status(401).json({ error: "Credenciales invalidas" });
    return;
  }

  const token = await createSessionToken({
    sub: user.id,
    email: user.email || "",
    name: [user.name, user.lastname].filter(Boolean).join(" "),
    role: user.role_name || "",
  });
  // Sin cookies: el token viaja al cliente y este lo manda en el header Authorization

  res.status(200).json({ token, user: mapUser(user, { id: user.id_role || 0, name: user.role_name }) });
});
