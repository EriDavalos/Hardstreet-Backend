import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requireSuperAdmin } from "../../../lib/permissions";
import { q, exec } from "../../../lib/db";
import { ok, created, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";

// ==================================================================
// SERVIDORES DEL DRIVE (Drive federado) -> /api/admin/drive-nodes
//   GET    { nodes: [...] }          lista todos (encendidos y apagados)
//   POST   { name, url, priority?, notes?, dependsOn? }   crea
//   PUT    { id, name?, url?, enabled?, priority?, notes?, dependsOn? }  edita
//   DELETE { id }                    quita
//
// La tabla `drive_nodes` es la lista que usa el HUB para repartir carpetas y
// subidas. Con una sola fila todo funciona como siempre.
// Requiere la migración 2026-10-25_drive_nodos_dependencias.sql.
//
// SOLO EL SUPERADMINISTRADOR: este endpoint manda sobre TODOS los servidores
// del Drive (y el hub deja de usarlos si se apaga uno), así que ni el rol
// Admin puede tocarlo. Antes bastaba el permiso del módulo «Conexión»; ahora
// se exige el rol Superadmin en cada método, aunque la tabla de permisos
// conceda el módulo.
// ==================================================================

const MAX_NODES = 20;

type NodeRow = {
  id: number;
  name: string;
  url: string;
  enabled: number;
  priority: number;
  notes: string | null;
  depends_on: string | null;
};

/** Fila de la API: la columna CSV se devuelve como lista de ids. */
type NodeOut = Omit<NodeRow, "depends_on"> & { dependsOn: number[] };

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

/** "1,3" → [1, 3]; tolera array, números sueltos y basura. */
function parseDepends(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(",");
  const out = new Set<number>();
  for (const item of raw) {
    const id = Number(item);
    if (Number.isFinite(id) && id > 0) out.add(Math.trunc(id));
  }
  return [...out].sort((a, b) => a - b);
}

const dependsCsv = (ids: number[]) => ids.join(",");

/** ¿La tabla ya tiene la columna `depends_on`? (migración aplicada). */
let hasDepends = true;

async function listNodes(): Promise<NodeOut[]> {
  let rows: NodeRow[];
  try {
    rows = await q<NodeRow>(
      `SELECT id, name, url, enabled, priority, notes, depends_on
         FROM drive_nodes
        ORDER BY priority ASC, id ASC`
    );
    hasDepends = true;
  } catch {
    // Base sin la migración: la pantalla sigue funcionando (sin dependencias)
    // en vez de quedarse vacía justo cuando se despliega el backend.
    hasDepends = false;
    const plain = await q<Omit<NodeRow, "depends_on">>(
      `SELECT id, name, url, enabled, priority, notes
         FROM drive_nodes
        ORDER BY priority ASC, id ASC`
    );
    rows = plain.map((r) => ({ ...r, depends_on: "" }));
  }
  return rows.map(({ depends_on, ...rest }) => ({
    ...rest,
    dependsOn: hasDepends ? parseDepends(depends_on) : [],
  }));
}

/**
 * Dependencias que llegan del panel, validadas contra la lista real.
 *
 * Devuelve `undefined` si el campo no venía, `null` si no es válido (y el
 * llamador responde 400) y la LISTA ya limpia si lo es. Un servidor no puede
 * depender de sí mismo ni de uno que no exista: eso dejaría el Drive en
 * mantenimiento para siempre y sin forma de arreglarlo desde la pantalla.
 */
type DependsResult =
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  | { kind: "ok"; ids: number[] };

function cleanDepends(
  body: Record<string, unknown>,
  selfId: number,
  nodes: NodeOut[]
): DependsResult {
  if (body.dependsOn === undefined && body.depends_on === undefined) {
    return { kind: "none" };
  }
  const ids = parseDepends(body.dependsOn ?? body.depends_on);
  if (selfId && ids.includes(selfId)) {
    return { kind: "invalid", reason: "Un servidor no puede depender de sí mismo" };
  }
  const known = new Set(nodes.map((n) => n.id));
  const missing = ids.filter((id) => id !== selfId && !known.has(id));
  if (missing.length) {
    return {
      kind: "invalid",
      reason: `Ese servidor ya no existe: ${missing.join(", ")}`,
    };
  }
  return { kind: "ok", ids };
}

/** QUÉ revisar si falta la migración (antes solo decía "hubo un error"). */
const MIGRATION_HINT =
  "Ejecuta Hardstreet-DB/2026-10-25_drive_nodos_dependencias.sql en la base del panel y vuelve a intentar";

const MIGRATION_MISSING =
  "Falta la columna de dependencias en la base de datos";

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  const body = (req.body || {}) as Record<string, unknown>;

  // La comprobación va PRIMERO para cualquier método: leer la lista también
  // revela direcciones internas de los servidores.
  const me = await requireSuperAdmin(
    req,
    res,
    "El módulo Conexión administra los servidores del Drive y solo lo puede usar el Superadministrador"
  );
  if (!me) return;

  try {
    // ---------------- LEER ----------------
    if (req.method === "GET") {
      const nodes = await listNodes();
      const missingIds = nodes.flatMap((n) =>
        n.dependsOn.filter((id) => !nodes.some((other) => other.id === id))
      );
      ok(res, "Servidores del Drive", {
        nodes,
        // Dependencias huérfanas (el servidor del que dependía se quitó): el
        // panel las enseña como aviso en vez de fingir que todo está bien.
        orphans: [...new Set(missingIds)],
      });
      return;
    }

    const nodes = await listNodes();

    // ---------------- CREAR / EDITAR ----------------
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      const url = cleanUrl(body.url);
      const name = cleanName(body.name);
      const priority = Math.max(1, Math.min(9999, asInt(body.priority, 100)));

      if (req.method === "POST") {
        if (!name) return fail(res, 400, "Falta el nombre del servidor", "Ej. «Servidor bodega»");
        if (!url) return fail(res, 400, "Dirección inválida", "Debe empezar con http:// o https://");
        if (nodes.length >= MAX_NODES) {
          return fail(res, 400, "Demasiados servidores", `El máximo es ${MAX_NODES}`);
        }
        const repeated = await q<NodeRow>("SELECT id FROM drive_nodes WHERE url = ? LIMIT 1", [url]);
        if (repeated.length) return fail(res, 409, "Ese servidor ya está registrado");
        const depends = cleanDepends(body, 0, nodes);
        if (depends.kind === "invalid") return fail(res, 400, depends.reason);
        const ids = depends.kind === "ok" ? depends.ids : [];
        if (ids.length && !hasDepends) {
          return fail(res, 400, MIGRATION_MISSING, MIGRATION_HINT);
        }
        const ins = hasDepends
          ? await exec(
              "INSERT INTO drive_nodes (name, url, enabled, priority, notes, depends_on) VALUES (?, ?, 1, ?, ?, ?)",
              [name, url, priority, String(body.notes || "").slice(0, 255), dependsCsv(ids)]
            )
          : await exec(
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
          details: { url, dependsOn: depends.kind === "ok" ? depends.ids : [] },
          req,
        });
        return created(res, "Servidor agregado", { node: row });
      }

      // PUT/PATCH: editar campos sueltos.
      const id = asInt(body.id, 0);
      if (!id) return fail(res, 400, "Falta el servidor a editar");
      const current = nodes.find((n) => n.id === id);
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
          const remaining = nodes.filter((n) => n.id !== id && Number(n.enabled) === 1);
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
      const depends = cleanDepends(body, id, nodes);
      if (depends.kind === "invalid") return fail(res, 400, depends.reason);
      if (depends.kind === "ok") {
        // Sin la columna NO se puede guardar. Antes se ignoraba en silencio y
        // la pantalla parecía que "no dejaba marcar" las dependencias.
        if (!hasDepends) return fail(res, 400, MIGRATION_MISSING, MIGRATION_HINT);
        fields.push("depends_on = ?");
        params.push(dependsCsv(depends.ids));
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
        details: { id, dependsOn: row?.dependsOn ?? [] },
        req,
      });
      return ok(res, "Servidor actualizado", { node: row });
    }

    // ---------------- QUITAR ----------------
    if (req.method === "DELETE") {
      const id = asInt(body.id, 0);
      if (!id) return fail(res, 400, "Falta el servidor a quitar");
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
      // Quien dependía de él se queda sin su dependencia: se limpia la columna
      // para que no quede un id fantasma bloqueando el Drive para siempre.
      if (hasDepends) {
        await exec(
          "UPDATE drive_nodes SET depends_on = TRIM(BOTH ',' FROM REPLACE(CONCAT(',', depends_on, ','), ?, ',')) WHERE depends_on <> ''",
          [`,${id},`]
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
    fail(res, 500, "Hubo un error", `No se pudo guardar el servidor. ${MIGRATION_HINT}`);
  }
});
