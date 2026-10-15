import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../lib/cors";
import { q } from "../../lib/db";

// ==================================================================
// DISEÑO DEL SITIO (público) -> /api/site
//   GET  { design, landing }
//
// Lo LEE la web al cargar: el diseño de las tarjetas de paquetes y el contenido
// de la portada que se editan desde el panel (Flutter). Es público a propósito:
// es la portada, la ve cualquiera, y así el sitio se actualiza en vivo sin
// volver a publicarlo.
//
// Nunca falla por falta de datos: si la migración todavía no se aplicó (o
// nadie ha diseñado nada) responde null en cada documento y la web usa sus
// valores por defecto (que son el look actual del sitio).
//
// El panel ESCRIBE en /api/admin/site (requiere permiso).
// ==================================================================

type Row = { design: unknown; landing: unknown };

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.status(405).json({
      code: 405,
      ok: false,
      error: "Método no permitido",
      message: "Usa GET para leer el diseño del sitio",
    });
    return;
  }

  // Caché corta en el borde: el diseño cambia muy de vez en cuando y la
  // portada se pide mucho. `stale-while-revalidate` evita que un visitante
  // espere por él.
  res.setHeader(
    "Cache-Control",
    "public, max-age=30, s-maxage=60, stale-while-revalidate=300"
  );

  try {
    const rows = await q<Row>(
      `SELECT design, landing FROM site_config WHERE id = 1 LIMIT 1`
    );
    const row = rows[0] || { design: null, landing: null };
    res.status(200).json({
      code: 200,
      ok: true,
      // Los documentos se devuelven TAL CUAL (null si no hay nada guardado):
      // cada cliente los mezcla con sus defaults.
      design: parseJson(row.design),
      landing: parseJson(row.landing),
    });
  } catch {
    // Migración pendiente o base caída: el sitio sigue con su look por defecto.
    res.status(200).json({ code: 200, ok: true, design: null, landing: null });
  }
});

/** mysql2 puede devolver JSON ya parseado o como texto: se acepta lo que venga. */
function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}
