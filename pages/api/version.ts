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

// El APK de actualización vive en la carpeta `downloads/` de un servidor del
// Drive, y lo publica el HUB en `/downloads/<archivo>`: él busca el nodo que
// tenga el release (aunque no sea el principal) y lo reenvía.
//
// Por eso el enlace apunta al HUB y no al nodo de archivos (`:4000`): la app
// solo tiene que poder llegar al hub, y el día que el APK esté en otro
// servidor el enlace sigue sirviendo sin tocar nada. Se puede sobreescribir
// con `RELEASES_BASE` (o el viejo `DRIVE_BASE`) y, archivo por archivo, con
// `DOWNLOAD_APK` / `DOWNLOAD_WIN`.
const DRIVE_BASE = (
  process.env.RELEASES_BASE ||
  process.env.DRIVE_BASE ||
  "https://oriongo.ddns.net"
).replace(/\/+$/, "");

const APP_RELEASE = {
  version: process.env.APP_VERSION || "1.0.5",
  minVersion: process.env.APP_MIN_VERSION || "1.0.5",
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
