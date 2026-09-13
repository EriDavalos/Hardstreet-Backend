// ==================================================================
// HARD STREET BACKEND - Auth (JWT via header Authorization)
// ==================================================================
import type { NextApiRequest, NextApiResponse } from "next";
import { SignJWT, jwtVerify } from "jose";


const MAX_AGE = 60 * 60 * 24 * 7; // 7 dias

function secret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("Falta JWT_SECRET en las variables de entorno");
  return new TextEncoder().encode(s);
}

export interface SessionPayload {
  sub: number; // user id
  email: string;
  name: string;
  role: string;
}

export async function createSessionToken(p: SessionPayload): Promise<string> {
  return new SignJWT({ email: p.email, name: p.name, role: p.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(p.sub))
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret());
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return {
      sub: Number(payload.sub),
      email: String(payload.email || ""),
      name: String(payload.name || ""),
      role: String(payload.role || ""),
    };
  } catch {
    return null;
  }
}

/** Lee la sesion desde el header Authorization: Bearer <token>. */
export async function getSession(req: NextApiRequest): Promise<SessionPayload | null> {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  const token = h.slice(7).trim();
  if (!token) return null;
  return verifySessionToken(token);
}

/** 401 si no hay sesion valida. Devuelve el payload o null (y ya respondio). */
export async function requireUser(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<SessionPayload | null> {
  const session = await getSession(req);
  if (!session) {
    res.status(401).json({ error: "No autenticado" });
    return null;
  }
  return session;
}
