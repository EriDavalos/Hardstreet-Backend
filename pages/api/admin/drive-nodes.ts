import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { q, exec } from "../../../lib/db";
import { ok, created, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";

// ==================================================================
// SERVIDORES DEL DRIVE (Drive federado) -> /api/admin/drive-nodes
//   GET    { nodes: [...] }          lista todos (encendidos y apagados)
//   POST   { name, url, priority?, notes? }   crea
//   PUT    { id, name?, url?, enabled?, priority?, notes? }  edita
//   DELETE { id }                    quita
//
// La tabla `drive_nodes` es la lista que usa el HUB para repartir carpetas y
// subidas. Con una sola fila todo funciona como siempre.
// Requiere la migración 2026-10-23_drive_nodos.sql.
// ==================================================================

const MODULE = "Conexión"; // muestra de Conexión = quien administra servidores
const MAX_NODES = 20;

type NodeRow = {
  id: number;
  name: string;
  url: string;
  enabled: number;
  priority: number;
  notes: string | null;
};

const asInt = (value: unknown, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

/** URL válida y SIN barra final (el hub la usa tal cual). */
function cleanUrl(value: unknown): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

function cleanName(value: unknown): string | null {
  const name = String(value || "").trim().slice(0, 120);
  return name || null;
}

async function listNodes(): Promise<NodeRow[]> {
  return q<NodeRow>(
    `SELECT id, name, url, enabled, priority, notes
       FROM drive_nodes
      ORDER BY priority ASC, id ASC`
  );
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  const body = (req.body || {}) as Record<string, unknown>;

  // Leer la lista: cualquiera que pueda VER Conexión.
  if (req.method === "GET") {
    const me = await requirePermission(req, res, MODULE, "read");
    if (!me) return;
    try {
      const nodes = await listNodes();
      ok(res, "Servidores del Drive", { nodes });
    } catch (e) {
      console.error("[admin/drive-nodes]", e);
      fail(
        res,
        500,
        "No se pudieron leer los servidores",
        "¿Aplicaste la migración 2026-10-23_drive_nodos.sql?"
      );
    }
    return;
  }

  // Crear / editar / borrar: permiso de ESCRITURA del módulo.
  const me = await requirePermission(req, res, MODULE, "update");
  if (!me) return;

  try {
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      const url = cleanUrl(body.url);
      const name = cleanName(body.name);
      const priority = Math.max(1, Math.min(9999, asInt(body.priority, 100)));
      if (req.method === "POST") {
        if (!name) return fail(res, 400, "Falta el nombre del servidor", "Ej. «Servidor bodega»");
        if (!url) return fail(res, 400, "Dirección inválida", "Debe empezar con http:// o https://");
        const count = (await listNodes()).length;
        if (count >= MAX_NODES) {
          return fail(res, 400, "Demasiados servidores", `El máximo es ${MAX_NODES}`);
        }
        const repeated = await q<NodeRow>("SELECT id FROM drive_nodes WHERE url = ? LIMIT 1", [url]);
        if (repeated.length) return fail(res, 409, "Ese servidor ya está registrado");
        const ins = await exec(
          "INSERT INTO drive_nodes (name, url, enabled, priority, notes) VALUES (?, ?, 1, ?, ?)",
          [name, url, priority, String(body.notes || "").slice(0, 255)]
        );
        const row = (await listNodes()).find((n) => n.id === ins.insertId) || null;
        await logActivity({
          userId: me.sub,
          module: "connection",
          moduleName: "Conexión",
          action: "create",
          entity: "servidor del Drive",
          description: `Servidor del Drive agregado: ${name}`,
          details: { url },
          req,
        });
        return created(res, "Servidor agregado", { node: row });
      }

      // PUT/PATCH: editar campos sueltos.
      const id = asInt(body.id, 0);
      if (!id) return fail(res, 400, "Falta el servidor a editar");
      const current = (await listNodes()).find((n) => n.id === id);
      if (!current) return fail(res, 404, "Ese servidor ya no existe");

      const fields: string[] = [];
      const params: unknown[] = [];
      if (body.name !== undefined) {
        if (!name) return fail(res, 400, "El nombre no puede quedar vacío");
        fields.push("name = ?");
        params.push(name);
      }
      if (body.url !== undefined) {
        if (!url) return fail(res, 400, "Dirección inválida", "Debe empezar con http:// o https://");
        const repeated = await q<NodeRow>(
          "SELECT id FROM drive_nodes WHERE url = ? AND id <> ? LIMIT 1",
          [url, id]
        );
        if (repeated.length) return fail(res, 409, "Otro servidor ya usa esa dirección");
        fields.push("url = ?");
        params.push(url);
      }
      if (body.enabled !== undefined) {
        const enabled = body.enabled === true || body.enabled === 1 || body.enabled === "1";
        // Nunca dejar el Drive sin ningún servidor encendido.
        if (!enabled) {
          const remaining = (await listNodes()).filter((n) => n.id !== id && Number(n.enabled) === 1);
          if (!remaining.length) {
            return fail(
              res,
              409,
              "Tiene que quedar al menos un servidor encendido",
              "Enciende otro antes de apagar este"
            );
          }
        }
        fields.push("enabled = ?");
        params.push(enabled ? 1 : 0);
      }
      if (body.priority !== undefined) {
        fields.push("priority = ?");
        params.push(priority);
      }
      if (body.notes !== undefined) {
        fields.push("notes = ?");
        params.push(String(body.notes || "").slice(0, 255));
      }
      if (!fields.length) return fail(res, 400, "Nada que guardar");
      await exec(`UPDATE drive_nodes SET ${fields.join(", ")} WHERE id = ?`, [...params, id]);
      const row = (await listNodes()).find((n) => n.id === id) || null;
      await logActivity({
        userId: me.sub,
        module: "connection",
        moduleName: "Conexión",
        action: "update",
        entity: "servidor del Drive",
        description: `Servidor del Drive actualizado: ${row?.name || id}`,
        details: { id },
        req,
      });
      return ok(res, "Servidor actualizado", { node: row });
    }

    if (req.method === "DELETE") {
      const id = asInt(body.id, 0);
      if (!id) return fail(res, 400, "Falta el servidor a quitar");
      const nodes = await listNodes();
      const row = nodes.find((n) => n.id === id);
      if (!row) return fail(res, 404, "Ese servidor ya no existe");
      if (nodes.filter((n) => n.id !== id && Number(n.enabled) === 1).length === 0) {
        return fail(
          res,
          409,
          "Tiene que quedar al menos un servidor",
          "Los archivos de ese servidor dejarían de verse"
        );
      }
      await exec("DELETE FROM drive_nodes WHERE id = ?", [id]);
      await logActivity({
        userId: me.sub,
        module: "connection",
        moduleName: "Conexión",
        action: "delete",
        entity: "servidor del Drive",
        description: `Servidor del Drive quitado: ${row.name}`,
        details: { url: row.url },
        req,
      });
      return ok(res, "Servidor quitado", { id });
    }

    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
  } catch (e) {
    console.error("[admin/drive-nodes]", e);
    fail(
      res,
      500,
      "Hubo un error",
      "No se pudo guardar el servidor. ¿Ya aplicaste la migración 2026-10-23_drive_nodos.sql?"
    );
  }
});
