import type { NextApiRequest, NextApiResponse } from "next";
import { q } from "../../../lib/db";

// ==================================================================
// LISTA DE SERVIDORES DEL DRIVE PARA EL HUB
//   GET /api/drive/nodes   (cabecera x-hub-token: DRIVE_HUB_TOKEN)
//
// Es un endpoint de SERVICIO: lo llama el hub del Drive federado, no el panel
// ni la web. Devuelve los nodos VIVOS —encendidos Y apagados—; el hub los
// consulta cada DRIVE_CONFIG_TTL segundos para saber a quién preguntar, dónde
// guardar y quién queda en mantenimiento.
//
// Por qué viajan los apagados: si un servidor se apaga (`enabled = 0`) y
// desapareciera de la lista, el hub no podría saber que existe y los que
// dependen de él seguirían usándose con medio árbol. Lo que NO viaja nunca es
// lo eliminado (`active = 0`).
//
// Sin CORS a propósito (server-to-server) y con un secreto compartido: nunca
// se exponen credenciales, solo nombres y URLs internas.
//
// `depends_on` (CSV de ids) dice de qué servidores depende cada uno: el hub
// bloquea al dependiente cuando el otro no responde (o está apagado). La
// consulta tiene un RESPALDO sin esa columna para que el hub siga funcionando
// aunque la migración 2026-10-25_drive_nodos_dependencias.sql no esté aplicada.
//
// `notes` viaja también: es la DESCRIPCIÓN que el panel enseña en la card de
// cada servidor. Sin ella el hub la reenviaba vacía y, con el hub conectado,
// la descripción desaparecía de la pantalla.
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
        `SELECT id, name, url, enabled, priority, notes, depends_on
           FROM drive_nodes
          WHERE active = 1
          ORDER BY priority ASC, id ASC`
      );
    } catch {
      try {
        // Base con borrado lógico pero sin la migración de dependencias.
        nodes = await q(
          `SELECT id, name, url, enabled, priority, notes
             FROM drive_nodes
            WHERE active = 1
            ORDER BY priority ASC, id ASC`
        );
      } catch {
        // Base sin `active` (migración pendiente): comportamiento viejo, solo
        // encendidos. El hub los toma como encendidos por defecto.
        nodes = await q(
          `SELECT id, name, url, priority, notes
             FROM drive_nodes
            WHERE enabled = 1
            ORDER BY priority ASC, id ASC`
        );
      }
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
