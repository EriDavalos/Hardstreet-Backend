// ==================================================================
// HARD STREET BACKEND - CORS
// Permite llamar la API desde el frontend estatico (otro puerto/dominio)
// ==================================================================
import type { NextApiRequest, NextApiResponse } from "next";

export function withCors(handler: (req: NextApiRequest, res: NextApiResponse) => void | Promise<void>) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
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
        res.status(500).json({ error: "Error interno del servidor" });
      }
    }
  };
}
