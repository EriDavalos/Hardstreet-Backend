import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../lib/cors";

// ==================================================================
// Versión publicada de la APP (Hardstreet Admin)  ->  /api/version
// La compara el cliente contra su versión compilada:
//   - current < minVersion → ventana OBLIGATORIA de actualización.
//   - current < version    → banner de "actualización disponible".
// Se controla con variables de entorno (sin redeploy del código):
//   APP_VERSION, APP_MIN_VERSION, APP_NOTES, DOWNLOAD_WIN, DOWNLOAD_APK,
//   DRIVE_BASE
// ==================================================================

// El APK de actualización vive en Hardstreet-Backend-Drive/downloads
// (ese proyecto se sube al servidor y lo publica en /downloads/<archivo>).
// Por defecto se apunta ahí; DOWNLOAD_APK permite sobreescribirlo.
const DRIVE_BASE = (
  process.env.DRIVE_BASE || "http://oriongo.ddns.net:4000"
).replace(/\/+$/, "");

const APP_RELEASE = {
  version: process.env.APP_VERSION || "1.0.1",
  minVersion: process.env.APP_MIN_VERSION || "1.0.1",
  notes: process.env.APP_NOTES || "",
  downloads: {
    // Sin .exe publicado todavía: vacío → el diálogo muestra "aún sin enlace".
    windows: process.env.DOWNLOAD_WIN || `${DRIVE_BASE}/downloads/desktop/app-release.exe`,
    android: process.env.DOWNLOAD_APK || `${DRIVE_BASE}/downloads/android/app-release.apk`,
  },
};

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Metodo no permitido" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(APP_RELEASE);
});
