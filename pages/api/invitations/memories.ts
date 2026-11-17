import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { q, exec } from "../../../lib/db";
import {
  driveBase,
  driveConfigured,
  driveEnsureFolder,
  driveFileUrl,
  driveUpload,
} from "../../../lib/drive-service";

// ==================================================================
// RECUERDOS DE UNA INVITACIÓN -> /api/invitations/memories
//
//   GET  ?slug=...             -> { photos: [{ id, name, url }] }
//   POST { slug, name, data }  -> sube UNA foto al Drive del estudio
//
// Las fotos NO viven en MySQL: se guardan en la carpeta del Drive que el
// estudio eligió para la invitación (`design.memoriesFolder`; si está vacía,
// `Recuerdos/<slug>`). La base solo guarda la ruta y la URL pública.
//
// El navegador manda la foto ya optimizada (1600 px, JPEG) y el backend la
// reenvía al Drive con un token de servicio. La clave de la liga sigue siendo
// la única credencial del invitado; por eso se comprueba en cada petición que
// la invitación siga publicada y activa.
// ==================================================================

export const config = {
  api: { bodyParser: { sizeLimit: "9mb" } },
};

const SLUG_SAFE = /^[a-z0-9]{6,40}$/i;
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_PHOTOS = 120;

let tableReady = false;

async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await exec(
    `CREATE TABLE IF NOT EXISTS invitation_recuerdos (
       id INT UNSIGNED NOT NULL AUTO_INCREMENT,
       slug VARCHAR(40) NOT NULL,
       name VARCHAR(160) NOT NULL DEFAULT '',
       path VARCHAR(700) NOT NULL,
       url VARCHAR(1000) NOT NULL,
       mime VARCHAR(40) NOT NULL,
       bytes INT UNSIGNED NOT NULL DEFAULT 0,
       created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       KEY idx_recuerdo_slug (slug, id)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  tableReady = true;
}

/** Diseño guardado de la invitación, solo si sigue publicada y activa. */
async function invitationDesign(
  slug: string
): Promise<Record<string, unknown> | null> {
  const rows = await q<{ design: unknown }>(
    `SELECT design FROM invitations
      WHERE slug = ? AND published = 1 AND active = 1
      LIMIT 1`,
    [slug]
  );
  if (!rows.length) return null;
  const raw = rows[0].design;
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string" && raw.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Carpeta del Drive: la elegida en la invitación o `Recuerdos/<slug>`. */
function memoriesFolder(design: Record<string, unknown>, slug: string): string {
  const raw = String(design.memoriesFolder ?? "").trim();
  const parts = raw
    .replaceAll("\\", "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== ".." && !s.startsWith("."));
  const clean = parts.join("/");
  return clean || `Recuerdos/${slug}`;
}

type PhotoRow = { id: number; name: string | null; url: string | null };

export default withCors(async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  res.setHeader("Cache-Control", "no-store");

  const body = (req.body ?? {}) as {
    slug?: unknown;
    name?: unknown;
    data?: unknown;
  };
  const slug = String(req.query.slug ?? body.slug ?? "").trim();

  if (!SLUG_SAFE.test(slug)) {
    res.status(400).json({ ok: false, error: "Liga de invitación no válida" });
    return;
  }

  try {
    const design = await invitationDesign(slug);
    if (!design) {
      res.status(404).json({
        ok: false,
        error: "Esta invitación no está disponible",
      });
      return;
    }

    await ensureTable();

    if (req.method === "GET") {
      const rows = await q<PhotoRow>(
        `SELECT id, name, url FROM invitation_recuerdos
          WHERE slug = ? ORDER BY id DESC LIMIT 150`,
        [slug]
      );
      res.status(200).json({
        ok: true,
        photos: rows.map((r) => ({
          id: Number(r.id),
          name: String(r.name ?? ""),
          url: String(r.url ?? ""),
        })),
      });
      return;
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      res.status(405).json({ ok: false, error: "Método no permitido" });
      return;
    }

    if (!driveConfigured()) {
      res.status(503).json({
        ok: false,
        error: "El Drive no está configurado (DRIVE_URL / JWT_SECRET)",
      });
      return;
    }

    const dataUrl = String(body.data ?? "");
    const match =
      /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(
        dataUrl
      );
    if (!match) {
      res.status(400).json({
        ok: false,
        error: "La foto no es válida (JPG, PNG o WebP)",
      });
      return;
    }

    const mime = match[1];
    const bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
    if (!bytes.length) {
      res.status(400).json({ ok: false, error: "La foto está vacía" });
      return;
    }
    if (bytes.length > MAX_BYTES) {
      res.status(413).json({
        ok: false,
        error: "La foto es demasiado grande. Prueba con otra.",
      });
      return;
    }

    const count = await q<{ n: number }>(
      `SELECT COUNT(*) AS n FROM invitation_recuerdos WHERE slug = ?`,
      [slug]
    );
    if (Number(count[0]?.n ?? 0) >= MAX_PHOTOS) {
      res.status(409).json({
        ok: false,
        error: "El álbum ya está completo. Gracias por compartir.",
      });
      return;
    }

    const folder = memoriesFolder(design, slug);
    await driveEnsureFolder(folder);

    const original = String(body.name ?? "")
      .replace(/\.[a-z0-9]{2,5}$/i, "")
      .replace(/[^\w .\-()]/g, "")
      .trim()
      .slice(0, 80);
    const filename = `${original || "recuerdo"}-${Date.now()}.jpg`;

    const saved = await driveUpload(
      folder,
      filename,
      new Uint8Array(bytes),
      mime
    );
    const path = `${folder}/${saved}`.replace(/\/+/g, "/");
    const url = driveFileUrl(path);

    const inserted = await exec(
      `INSERT INTO invitation_recuerdos (slug, name, path, url, mime, bytes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [slug, filename, path, url, mime, bytes.length]
    );

    res.status(201).json({
      ok: true,
      id: inserted.insertId,
      name: filename,
      url,
      drive: driveBase(),
    });
  } catch (e) {
    console.error("[invitaciones/memories]", e);
    res.status(503).json({
      ok: false,
      error:
        "No se pudo guardar la foto en el Drive. Inténtalo de nuevo en un momento.",
    });
  }
});
