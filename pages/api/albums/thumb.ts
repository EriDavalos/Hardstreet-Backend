import type { NextApiRequest, NextApiResponse } from "next";
import { publicAlbum } from "../../../lib/albums";
import { driveFetch } from "../../../lib/drive-service";

// ==================================================================
// MINIATURA DE UN ÁLBUM -> /api/albums/thumb?slug=...&name=...[&w=480]
//
// Usa las miniaturas que ya genera el Drive (y su caché en disco). Para un
// vídeo devuelve su primer fotograma; si no puede, 404 y la cuadrícula pinta
// el icono del tipo.
// ==================================================================

const SLUG_SAFE = /^[a-z0-9]{6,40}$/i;

function safeName(raw: unknown): string {
  const s = String(raw ?? "").trim().replaceAll("\\", "/");
  if (!s || s.includes("/") || s.startsWith(".") || s.includes("..")) return "";
  return s.slice(0, 255);
}

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
  const name = safeName(req.query.name);
  const width = Math.min(1200, Math.max(160, Number(req.query.w || 480)));
  if (!SLUG_SAFE.test(slug) || !name) {
    res.status(400).json({ ok: false, error: "Archivo no válido" });
    return;
  }

  try {
    const album = await publicAlbum(slug);
    if (!album) {
      res.status(404).json({ ok: false, error: "Álbum no disponible" });
      return;
    }
    const folder = String(album.folder || "").replace(/\/+$/, "");
    const target = `${folder}/${name}`
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");

    const upstream = await driveFetch(`/thumb/${target}?w=${width}`);
    if (!upstream.ok) {
      res.status(404).json({ ok: false, error: "Sin miniatura" });
      return;
    }
    res.setHeader(
      "Content-Type",
      upstream.headers.get("content-type") || "image/jpeg"
    );
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method === "HEAD") {
      res.status(200).end();
      return;
    }
    res.status(200).send(Buffer.from(await upstream.arrayBuffer()));
  } catch (e) {
    console.error("[albums/thumb]", e);
    res.status(503).json({ ok: false, error: "No se pudo abrir la miniatura" });
  }
}
