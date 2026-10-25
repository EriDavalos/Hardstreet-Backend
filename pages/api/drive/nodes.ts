import type { NextApiRequest, NextApiResponse } from "next";
import { q } from "../../../lib/db";

// ==================================================================
// LISTA DE SERVIDORES DEL DRIVE PARA EL HUB
//   GET /api/drive/nodes   (cabecera x-hub-token: DRIVE_HUB_TOKEN)
//
// Es un endpoint de SERVICIO: lo llama el hub del Drive federado, no el panel
// ni la web. Devuelve solo los nodos encendidos; el hub los consulta cada
// DRIVE_CONFIG_TTL segundos para saber a quién preguntar y dónde guardar.
//
// Sin CORS a propósito (server-to-server) y con un secreto compartido: nunca
// se exponen credenciales, solo nombres y URLs internas.
//
// `depends_on` (CSV de ids) dice de qué servidores depende cada uno: el hub
// bloquea al dependiente cuando el otro no responde. La consulta tiene un
// RESPALDO sin esa columna para que el hub siga funcionando aunque la
// migración 2026-10-25_drive_nodos_dependencias.sql aún no esté aplicada.
// ==================================================================

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const expected = process.env.DRIVE_HUB_TOKEN || "";
  const received = String(req.headers["x-hub-token"] || "");
  if (!expected || received !== expected) {
    res.status(401).json({ ok: false, error: "No autorizado" });
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: `${req.method} no está soportado` });
    return;
  }
  try {
    let nodes;
    try {
      nodes = await q(
        `SELECT id, name, url, priority, depends_on
           FROM drive_nodes
          WHERE enabled = 1
          ORDER BY priority ASC, id ASC`
      );
    } catch {
      // Base sin la migración de dependencias: se sirve la lista de siempre.
      nodes = await q(
        `SELECT id, name, url, priority
           FROM drive_nodes
          WHERE enabled = 1
          ORDER BY priority ASC, id ASC`
      );
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ nodes });
  } catch (e) {
    console.error("[drive/nodes]", e);
    res.status(500).json({
      ok: false,
      error: "No se pudieron leer los servidores del Drive",
      details: "¿Aplicaste la migración 2026-10-23_drive_nodos.sql?",
    });
  }
}
