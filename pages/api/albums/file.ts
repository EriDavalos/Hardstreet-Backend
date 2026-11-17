import type { NextApiRequest, NextApiResponse } from "next";
import { publicAlbum } from "../../../lib/albums";
import { driveFetch } from "../../../lib/drive-service";

// ==================================================================
// ARCHIVO DE UN ÁLBUM -> /api/albums/file?slug=...&name=...
//
// Reenvía el archivo desde el Drive. Se conserva el `Range` para que un vídeo
// grande empiece a verse en segundos y se pueda adelantar.
// ==================================================================

const SLUG_SAFE = /^[a-z0-9]{6,40}$/i;

/** Nombre de archivo seguro (sin rutas ni ocultos). */
function safeName(raw: unknown): string {
  const s = String(raw ?? "").trim().replaceAll("\\", "/");
  if (!s || s.includes("/") || s.startsWith(".") || s.includes("..")) return "";
  return s.slice(0, 255);
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
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
    const target = `${folder}/${name}`;
    const headers: Record<string, string> = {};
    const range = String(req.headers.range || "").trim();
    if (range) headers.Range = range;

    const upstream = await driveFetch(`/files/${encodePath(target)}`, {
      headers,
    });
    if (!upstream.ok && upstream.status !== 206) {
      res.status(404).json({ ok: false, error: "Archivo no encontrado" });
      return;
    }

    res.status(upstream.status);
    for (const key of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "etag",
      "last-modified",
    ]) {
      const value = upstream.headers.get(key);
      if (value) res.setHeader(key, value);
    }
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  } catch (e) {
    console.error("[albums/file]", e);
    res.status(503).json({ ok: false, error: "No se pudo abrir el archivo" });
  }
}
