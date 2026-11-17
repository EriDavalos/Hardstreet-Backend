import type { NextApiRequest, NextApiResponse } from "next";
import { q } from "../../../lib/db";
import { driveFetch, driveFilePath } from "../../../lib/drive-service";

// ==================================================================
// FOTO DE UN RECUERDO -> /api/invitations/memory?slug=...&id=...
//
// La foto vive en el Drive; aquí se pide con el token de servicio y se
// devuelve al navegador. Así el álbum no obliga a publicar la carpeta entera
// del Drive y despublicar la invitación apaga también las fotos.
//
// Soporta Range: un vídeo no aplica aquí (solo fotos), pero la cabecera se
// reenvía por si el archivo servido cambia de tipo.
// ==================================================================

const SLUG_SAFE = /^[a-z0-9]{6,40}$/i;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    res.status(405).json({ ok: false, error: "Método no permitido" });
    return;
  }

  const slug = String(req.query.slug ?? "").trim();
  const id = Number(req.query.id ?? 0);
  if (!SLUG_SAFE.test(slug) || !Number.isInteger(id) || id <= 0) {
    res.status(400).json({ ok: false, error: "Foto no válida" });
    return;
  }

  try {
    const rows = await q<{ path: string; mime: string }>(
      `SELECT r.path, r.mime
         FROM invitation_recuerdos r
         JOIN invitations i
           ON i.slug = r.slug AND i.published = 1 AND i.active = 1
        WHERE r.slug = ? AND r.id = ?
        LIMIT 1`,
      [slug, id]
    );
    const row = rows[0];
    if (!row?.path) {
      res.status(404).json({ ok: false, error: "Foto no encontrada" });
      return;
    }

    const upstream = await driveFetch(driveFilePath(row.path));
    if (!upstream.ok) {
      res.status(404).json({ ok: false, error: "Foto no encontrada" });
      return;
    }

    const mime = /^image\/(jpeg|png|webp|gif)$/i.test(String(row.mime))
      ? String(row.mime)
      : String(upstream.headers.get("content-type") || "image/jpeg");
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");

    const length = upstream.headers.get("content-length");
    if (length) res.setHeader("Content-Length", length);

    if (req.method === "HEAD") {
      res.status(200).end();
      return;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.status(200).send(buffer);
  } catch (e) {
    console.error("[invitaciones/memory]", e);
    res.status(503).json({ ok: false, error: "No se pudo abrir la foto" });
  }
}
