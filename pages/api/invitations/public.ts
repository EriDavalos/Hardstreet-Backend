import type { NextApiRequest, NextApiResponse } from "next";
import { q } from "../../../lib/db";

// ==================================================================
// INVITACIÓN PÚBLICA -> GET /api/invitations/public?slug=...
//
// Lo que ve el CLIENTE al abrir la liga /i/<slug> (el rewrite de
// next.config.ts manda esa ruta aquí). Devuelve el HTML que el panel
// generó y guardó al guardar la invitación: no se re-renderiza nada en el
// servidor, así que la página es EXACTAMENTE la que se previsualizó.
//
// Reglas:
//   · solo se sirve si `published = 1` y `active = 1`;
//   · sin sesión (la liga es para el cliente, no para el equipo);
//   · `no-store`: si se despublica, deja de verse al instante;
//   · no se expone nada más de la fila (ni la empresa ni el autor).
// ==================================================================

const UUID_SAFE = /^[a-z0-9]{6,40}$/i;

/** Página mínima para cuando no hay nada que enseñar. */
function notice(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    padding: 28px; background: #0b1220; color: #f6f1e7;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    text-align: center;
  }
  .card {
    max-width: 420px; padding: 34px 26px; border-radius: 22px;
    background: rgba(255,255,255,.04);
    border: 1px solid rgba(201,169,110,.28);
  }
  h1 { margin: 0 0 10px; font-size: 20px; letter-spacing: .02em; }
  p { margin: 0; font-size: 14px; line-height: 1.6; color: #c8bfae; }
</style>
</head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body>
</html>`;
}

function sendHtml(res: NextApiResponse, status: number, html: string) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Robots-Tag", "noindex");
  // La invitación solo necesita cargar fotos del Drive; nada de scripts
  // externos más allá del propio HTML guardado.
  res.status(status).send(html);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    sendHtml(
      res,
      405,
      notice("No disponible", "Esta dirección solo se puede abrir en el navegador.")
    );
    return;
  }

  const slug = String(req.query.slug ?? "").trim();
  if (!UUID_SAFE.test(slug)) {
    sendHtml(
      res,
      404,
      notice(
        "Invitación no encontrada",
        "Revisa la liga: puede estar incompleta o haberse copiado mal."
      )
    );
    return;
  }

  try {
    const rows = await q<{
      html: string | null;
      published: number;
      active: number;
    }>(
      `SELECT html, published, active
         FROM invitations
        WHERE slug = ?
        LIMIT 1`,
      [slug]
    );
    const row = rows[0];
    const html = String(row?.html ?? "").trim();
    const available =
      Boolean(row) && Number(row!.active) === 1 && Number(row!.published) === 1;

    if (!available || !html) {
      sendHtml(
        res,
        404,
        notice(
          "Esta invitación no está disponible",
          "Puede que todavía no se haya publicado o que ya no esté activa. " +
            "Pídele a quien te la compartió que te mande la liga de nuevo."
        )
      );
      return;
    }

    sendHtml(res, 200, html);
  } catch (e) {
    console.error("[invitaciones/public]", e);
    sendHtml(
      res,
      503,
      notice(
        "No se pudo abrir la invitación",
        "Vuelve a intentarlo en un momento."
      )
    );
  }
}
