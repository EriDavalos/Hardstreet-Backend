import { SignJWT } from "jose";

// ==================================================================
// SERVICIO DEL DRIVE — puente entre el backend y el servidor propio
//
// Las fotos de «Recuerdos» y los Álbumes digitales NO se guardan en la base:
// viven en el Drive (hardstreet-drive). La base solo guarda la ruta y la URL.
//
// El backend habla con el Drive como un usuario de SERVICIO: firma un JWT con
// el mismo JWT_SECRET que usa el panel y el Drive lo acepta como
// superadministrador. Ese token nunca sale al navegador.
//
// Variables:
//   DRIVE_URL          https://drive.tudominio.com (sin barra final)
//   DRIVE_SERVICE_USER id del usuario de servicio (por defecto 1)
//   JWT_SECRET         el mismo del panel y del Drive
// ==================================================================

const DRIVE_URL = String(process.env.DRIVE_URL || "")
  .trim()
  .replace(/\/+$/, "");
const SERVICE_USER = Number(process.env.DRIVE_SERVICE_USER || 1);

let cachedToken = "";
let cachedUntil = 0;

export function driveBase(): string {
  return DRIVE_URL;
}

export function driveConfigured(): boolean {
  return Boolean(DRIVE_URL && process.env.JWT_SECRET);
}

/** Token de servicio (se reutiliza mientras no caduque). */
export async function driveToken(): Promise<string> {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("Falta JWT_SECRET en el backend");
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedUntil - 60 > now) return cachedToken;
  const token = await new SignJWT({
    email: "servicio@hardstreet.com",
    name: "Hardstreet",
    role: "superadmin",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(SERVICE_USER || 1))
    .setIssuedAt()
    .setExpirationTime("30m")
    .sign(new TextEncoder().encode(secret));
  cachedToken = token;
  cachedUntil = now + 30 * 60;
  return token;
}

/** Petición autenticada al Drive. Devuelve la Response tal cual. */
export async function driveFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  if (!DRIVE_URL) throw new Error("Falta DRIVE_URL en el backend");
  const token = await driveToken();
  const headers = new Headers(init.headers as HeadersInit | undefined);
  headers.set("Apikey", token);
  return fetch(`${DRIVE_URL}${path}`, { ...init, headers });
}

/** JSON del Drive (lanza si la respuesta no es 2xx). */
export async function driveJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await driveFetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Drive ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/**
 * Sube UN archivo a una carpeta del Drive. Devuelve el nombre definitivo
 * (el Drive renombra `foto.jpg` a `foto (1).jpg` si ya existe).
 */
export async function driveUpload(
  folder: string,
  name: string,
  bytes: Uint8Array,
  mime: string
): Promise<string> {
  const form = new FormData();
  form.append("path", folder);
  form.append(
    "files",
    new Blob([bytes.buffer as ArrayBuffer], { type: mime }),
    name
  );
  // El Drive responde { saved: <número>, names: [<nombre definitivo>] }.
  const data = await driveJson<{ saved?: number; names?: string[] }>(
    "/api/upload",
    { method: "POST", body: form }
  );
  const saved = Array.isArray(data.names) ? data.names[0] : "";
  return String(saved || name);
}

/** Crea la carpeta y sus padres (idempotente). */
export async function driveEnsureFolder(folder: string): Promise<void> {
  await driveJson("/api/node/ensure", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: folder }),
  });
}

/** Ruta interna de un archivo, tal como la sirve `/files`. */
export function driveFilePath(path: string): string {
  return `/files/${path
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/")}`;
}

/** URL absoluta del archivo en el Drive. */
export function driveFileUrl(path: string): string {
  return `${DRIVE_URL}${driveFilePath(path)}`;
}

export type DriveEntry = {
  name: string;
  isFolder: boolean;
  modified?: number;
  size?: number;
  kind?: string;
};

export type DriveListing = { path?: string; folders?: DriveEntry[] };

/** Lista una carpeta del Drive. */
export async function driveList(folder: string): Promise<DriveEntry[]> {
  const query = new URLSearchParams({ path: folder }).toString();
  const data = await driveJson<DriveListing>(`/api/drive?${query}`);
  return Array.isArray(data.folders) ? data.folders : [];
}
