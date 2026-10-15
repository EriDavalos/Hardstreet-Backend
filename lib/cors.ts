// ==================================================================
// HARD STREET BACKEND - CORS
// Permite llamar la API desde el frontend estatico (otro puerto/dominio)
// ==================================================================
import type { NextApiRequest, NextApiResponse } from "next";
import { fail } from "./api-response";

export function withCors(handler: (req: NextApiRequest, res: NextApiResponse) => void | Promise<void>) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    // La respuesta DEPENDE de quién la pide (el "Allow-Origin" se copia del
    // Origin), así que el caché debe guardarse POR ORIGEN. Sin esto, un borde
    // que cachea la respuesta (como /api/site, con s-maxage) le entrega a un
    // visitante la copia cacheada de OTRO origen: su navegador la rechaza por
    // CORS (el "Allow-Origin" no coincide) y el sitio no ve lo que hay en la
    // base de datos.
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.status(200).end();
      return;
    }
    try {
      return await handler(req, res);
    } catch (e) {
      // Sin DB o error inesperado -> JSON en vez de HTML 500
      console.error("[API]", e);
      if (!res.headersSent) {
        fail(res, 500, "Hubo un error", "Error interno del servidor");
      }
    }
  };
}
