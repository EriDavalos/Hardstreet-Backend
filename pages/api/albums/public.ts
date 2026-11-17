import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { albumTheme, listAlbumItems, publicAlbum } from "../../../lib/albums";

// ==================================================================
// ÁLBUM DIGITAL PÚBLICO -> GET /api/albums/public?slug=...
//
// Lo consume la página /album/<liga>. Devuelve los datos del álbum y los
// archivos que hay AHORA en su carpeta del Drive: el estudio sube fotos y
// aparecen solas, sin volver a publicar nada.
//
// Solo se exponen el nombre, el tipo y el tamaño de cada archivo. La carpeta
// real del Drive no se revela en la respuesta.
// ==================================================================

const SLUG_SAFE = /^[a-z0-9]{6,40}$/i;

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ ok: false, error: "Método no permitido" });
    return;
  }
  const slug = String(req.query.slug ?? "").trim();
  if (!SLUG_SAFE.test(slug)) {
    res.status(400).json({ ok: false, error: "Liga no válida" });
    return;
  }

  try {
    const album = await publicAlbum(slug);
    if (!album) {
      res.status(404).json({ ok: false, error: "Álbum no disponible" });
      return;
    }
    const items = await listAlbumItems(String(album.folder || ""));
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=120");
    res.status(200).json({
      ok: true,
      album: {
        title: String(album.title || ""),
        theme: albumTheme(album.theme),
        eventDate: String(album.event_date || ""),
        cover: items.find((i) => i.kind === "image")?.name || "",
      },
      items: items.map((i) => ({
        name: i.name,
        kind: i.kind,
        size: i.size,
        file: `/api/albums/file?slug=${encodeURIComponent(slug)}&name=${encodeURIComponent(i.name)}`,
        thumb: `/api/albums/thumb?slug=${encodeURIComponent(slug)}&name=${encodeURIComponent(i.name)}`,
      })),
    });
  } catch (e) {
    console.error("[albums/public]", e);
    res.status(503).json({
      ok: false,
      error: "No se pudo abrir el álbum. Vuelve a intentarlo en un momento.",
    });
  }
});
