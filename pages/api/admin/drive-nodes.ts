import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requireSuperAdmin } from "../../../lib/permissions";
import { q, exec } from "../../../lib/db";
import { ok, created, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";

// ==================================================================
// SERVIDORES DEL DRIVE (Drive federado) -> /api/admin/drive-nodes
//   GET    { nodes: [...] }          lista los VIVOS (active = 1)
//   POST   { name, url, priority?, notes?, dependsOn? }   crea
//   PUT    { id, name?, url?, enabled?, priority?, notes?, dependsOn? }  edita
//   DELETE { id }                    ELIMINA (borrado lógico: active = 0)
//
// LAS DEPENDENCIAS SON MUTUAS: guardar `dependsOn` en un servidor escribe el
// enlace en el otro extremo, y quitarlo lo quita de allá. Un enlace viejo de un
// solo lado se completa al leer la lista, y al eliminar un servidor se limpia
// del otro extremo (si no, quedaría bloqueado para siempre sin casilla que
// desmarcar).
//
// DOS CAMPOS DISTINTOS, a propósito:
//   · `active`  = 1 vivo / 0 ELIMINADO. Un active = 0 no se sirve: para el
//     panel y el hub ese servidor ya no existe (la fila se conserva).
//   · `enabled` = 1 encendido / 0 APAGADO. Sigue en la lista (el panel lo
//     enseña apagado) pero el hub no lo usa, y quien dependa de él queda en
//     mantenimiento con su aviso en el Drive.
// Antes `enabled` hacía las dos cosas y un servidor apagado desaparecía, así
// que no había forma de avisar de los dependientes.
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
  active: number;
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

/** ¿La tabla ya tiene la columna `active`? (migración 2026-10-26). */
let hasActive = true;

async function listNodes(): Promise<NodeOut[]> {
  const base = "SELECT id, name, url, enabled, priority, notes";
  // 1) Esquema completo (dependencias + borrado lógico).
  try {
    const rows = await q<NodeRow>(
      `${base}, active, depends_on
         FROM drive_nodes
        ORDER BY priority ASC, id ASC`
    );
    hasDepends = true;
    hasActive = true;
    return rows.map(({ depends_on, ...rest }) => ({
      ...rest,
      dependsOn: parseDepends(depends_on),
    }));
  } catch {
    // Se sigue abajo.
  }
  // 2) Sin dependencias (pero con borrado lógico).
  try {
    const rows = await q<NodeRow & { depends_on?: string }>(
      `${base}, active
         FROM drive_nodes
        ORDER BY priority ASC, id ASC`
    );
    hasDepends = false;
    hasActive = true;
    return rows.map((r) => ({ ...r, depends_on: "", dependsOn: [] }));
  } catch {
    // Se sigue abajo.
  }
  // 3) Base sin `active` (migración pendiente): todo lo que hay está vivo.
  //    No se rompe la pantalla justo cuando se despliega el backend.
  hasDepends = false;
  hasActive = false;
  const plain = await q<Omit<NodeRow, "depends_on" | "active">>(
    `${base}
       FROM drive_nodes
      ORDER BY priority ASC, id ASC`
  );
  return plain.map((r) => ({ ...r, active: 1, depends_on: "", dependsOn: [] }));
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

/**
 * Completa los enlaces que quedaron de UN SOLO LADO.
 *
 * Antes de que la dependencia fuera mutua se podía guardar `A → B` sin que B
 * supiera nada. Esos datos siguen en la base, así que la primera lectura del
 * panel los empareja (añade A a la lista de B) para que la regla valga también
 * para lo ya guardado: el hub y el diagrama ven el mismo enlace desde ese
 * momento. No quita nada, solo completa, y es idempotente: con los datos ya
 * simétricos no escribe ni una fila.
 */
async function normalizeDepends(nodes: NodeOut[]): Promise<void> {
  const known = new Set(nodes.map((n) => n.id));
  const want = new Map<number, Set<number>>();
  const addPair = (a: number, b: number) => {
    if (!want.has(a)) want.set(a, new Set());
    want.get(a)!.add(b);
  };
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (dep === node.id || !known.has(dep)) continue;
      addPair(node.id, dep);
      addPair(dep, node.id);
    }
  }
  for (const node of nodes) {
    const targets = want.get(node.id);
    if (!targets) continue;
    const missing = [...targets].filter((id) => !node.dependsOn.includes(id));
    if (!missing.length) continue;
    node.dependsOn = [...node.dependsOn, ...missing].sort((a, b) => a - b);
    await exec("UPDATE drive_nodes SET depends_on = ? WHERE id = ?", [
      dependsCsv(node.dependsOn),
      node.id,
    ]);
  }
}

/**
 * HACE MUTUA la dependencia al guardar.
 *
 * La regla del panel es que depender de un servidor es un ENLACE entre los
 * dos: si A dice depender de B, B también depende de A. Antes se podía guardar
 * `A → B` y nada más, así que el diagrama enseñaba una relación de un solo lado
 * —que además bloqueaba a A sin que B supiera que estaban unidos— y mirando a B
 * no había forma de saber con quién estaba enlazado.
 *
 * Aquí se escribe el otro extremo: se añade el id a quien ahora lo declara y
 * se quita de quien ya no. Así la base nunca queda con un enlace a medias,
 * venga el guardado del panel o de otra herramienta.
 */
async function mirrorDepends(
  id: number,
  ids: number[],
  all: NodeOut[]
): Promise<void> {
  for (const other of all) {
    if (other.id === id || Number(other.active) !== 1) continue;
    const has = other.dependsOn.includes(id);
    const wants = ids.includes(other.id);
    if (wants === has) continue;
    const next = wants
      ? [...other.dependsOn, id]
      : other.dependsOn.filter((dep) => dep !== id);
    await exec("UPDATE drive_nodes SET depends_on = ? WHERE id = ?", [
      dependsCsv(next),
      other.id,
    ]);
  }
}

/** QUÉ revisar si falta la migración (antes solo decía "hubo un error"). */
const MIGRATION_HINT =
  "Ejecuta Hardstreet-DB/2026-10-25_drive_nodos_dependencias.sql en la base del panel y vuelve a intentar";

const MIGRATION_MISSING =
  "Falta la columna de dependencias en la base de datos";

const MIGRATION_HINT_ACTIVE =
  "Ejecuta Hardstreet-DB/2026-10-26_drive_nodos_active.sql en la base del panel y vuelve a intentar";

const MIGRATION_MISSING_ACTIVE =
  "Falta la columna de borrado lógico (`active`) en la base de datos";

type DbError = {
  code?: string;
  errno?: number;
  sqlMessage?: string;
  message?: string;
};

/**
 * ¿El fallo es de ESQUEMA (falta la migración)?
 *
 * Solo entonces tiene sentido mandar al usuario a ejecutar el .sql. Antes el
 * `catch` culpaba a la migración de CUALQUIER error (un tiempo de espera, una
 * llave foránea, un privilegio…) y el panel repetía «ejecuta el .sql» aunque
 * ya estuviera aplicado.
 */
function isSchemaError(e: unknown): boolean {
  const code = String((e as DbError)?.code || "");
  return (
    code === "ER_BAD_FIELD_ERROR" ||
    code === "ER_NO_SUCH_TABLE" ||
    code === "ER_UNKNOWN_COLUMN"
  );
}

/** El error REAL de la base, en corto (sin credenciales ni la consulta). */
function dbDetail(e: unknown): string {
  const db = (e || {}) as DbError;
  const message = String(db.sqlMessage || db.message || e || "").trim();
  const code = String(db.code || "").trim();
  const text = code ? `${code}: ${message}` : message;
  return text.slice(0, 240) || "La base de datos rechazó la operación";
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  const body = (req.body || {}) as Record<string, unknown>;
  // Para que el aviso de error diga lo que de verdad se estaba haciendo.
  const verb = req.method === "DELETE" ? "desactivar" : "guardar";

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
      // BORRADO LÓGICO: un `active = 0` no se sirve. La fila sigue en la base
      // (para no perder el historial), pero para el panel ese servidor ya no
      // existe: no se pinta, no se cuenta y no se ofrece como dependencia.
      // Filtrar aquí —y no en la app— evita que se cuele por cualquier otra
      // pantalla que lea la lista. Los APAGADOS (enabled = 0) sí se sirven:
      // tienen que verse para poder encenderlos y para que el hub avise de
      // los servidores que dependen de ellos.
      const nodes = (await listNodes()).filter(
        (n) => Number(n.active) === 1
      );
      // Los enlaces viejos de un solo lado se completan aquí (una sola vez).
      if (hasDepends) await normalizeDepends(nodes);
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

    // `all` incluye las filas eliminadas (para poder restaurarlas por API y
    // para no perder su historial); `nodes` es lo que existe para el panel.
    const all = await listNodes();
    const nodes = all.filter((n) => Number(n.active) === 1);

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
        // Solo cuenta lo VIVO: la dirección de un servidor eliminado se puede
        // volver a registrar sin tocar la base a mano.
        if (nodes.some((n) => n.url === url)) {
          return fail(res, 409, "Ese servidor ya está registrado");
        }
        const depends = cleanDepends(body, 0, nodes);
        if (depends.kind === "invalid") return fail(res, 400, depends.reason);
        const ids = depends.kind === "ok" ? depends.ids : [];
        if (ids.length && !hasDepends) {
          return fail(res, 400, MIGRATION_MISSING, MIGRATION_HINT);
        }
        // Columnas según las migraciones aplicadas: en una base vieja la
        // pantalla sigue funcionando (sin `active` ni dependencias).
        const cols = ["name", "url", "enabled"];
        const values: unknown[] = [name, url, 1];
        if (hasActive) {
          cols.push("active");
          values.push(1);
        }
        cols.push("priority", "notes");
        values.push(priority, String(body.notes || "").slice(0, 255));
        if (hasDepends) {
          cols.push("depends_on");
          values.push(dependsCsv(ids));
        }
        const ins = await exec(
          `INSERT INTO drive_nodes (${cols.join(", ")}) VALUES (${cols
            .map(() => "?")
            .join(", ")})`,
          values
        );
        // El enlace es mutuo: el otro extremo se entera en el mismo guardado.
        await mirrorDepends(ins.insertId, ids, nodes);
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
      // Se busca en TODAS las filas: una eliminada se puede volver a activar
      // con `PUT { id, active: true }` (restaurar) sin tocarla a mano en la base.
      const current = all.find((n) => n.id === id);
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
      // ENCENDIDO / APAGADO (enabled): el servidor sigue en la lista, pero el
      // hub deja de usarlo y sus dependientes quedan en mantenimiento.
      if (body.enabled !== undefined) {
        const enabled = body.enabled === true || body.enabled === 1 || body.enabled === "1";
        // Nunca dejar el Drive sin ningún servidor VIVO y encendido.
        if (!enabled) {
          const remaining = nodes.filter(
            (n) =>
              n.id !== id &&
              Number(n.active) === 1 &&
              Number(n.enabled) === 1
          );
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
      // BORRADO LÓGICO (active): el servidor deja de existir para el panel y
      // para el hub. La fila se conserva con sus datos.
      if (body.active !== undefined) {
        if (!hasActive) {
          return fail(res, 400, MIGRATION_MISSING_ACTIVE, MIGRATION_HINT_ACTIVE);
        }
        const active =
          body.active === true || body.active === 1 || body.active === "1";
        if (!active) {
          const remaining = nodes.filter(
            (n) =>
              n.id !== id &&
              Number(n.active) === 1 &&
              Number(n.enabled) === 1
          );
          if (!remaining.length) {
            return fail(
              res,
              409,
              "Tiene que quedar al menos un servidor encendido",
              "Enciende o agrega otro antes de eliminar este"
            );
          }
        }
        fields.push("active = ?");
        params.push(active ? 1 : 0);
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
      // DEPENDENCIA MUTUA: lo que se marcó aquí se marca también en el otro
      // servidor, y lo que se desmarcó se quita de allá.
      if (depends.kind === "ok") await mirrorDepends(id, depends.ids, nodes);
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

    // ---------------- ELIMINAR (borrado lógico: active = 0) ----------------
    //
    // Quitar un servidor NO borra la fila: se marca `active = 0` y desaparece
    // del panel y del hub (sus dependientes ya no lo ven como disponible).
    // La fila conserva nombre, dirección, prioridad, notas y dependencias.
    //
    // Ojo: esto es DISTINTO de apagarlo (`enabled = 0`), que sí se hace desde
    // el panel con «Apagar en el Drive» y deja el servidor a la vista, con sus
    // dependientes en mantenimiento y el aviso en el Drive.
    if (req.method === "DELETE") {
      const id = asInt(body.id, 0);
      if (!id) return fail(res, 400, "Falta el servidor a eliminar");
      const row = all.find((n) => n.id === id);
      if (!row) return fail(res, 404, "Ese servidor ya no existe");
      if (Number(row.active) !== 1) {
        return ok(res, "Ese servidor ya estaba eliminado", {
          id,
          active: 0,
          node: row,
        });
      }
      // Nunca dejar el Drive sin ningún servidor vivo y encendido.
      const alive = nodes.filter(
        (n) => n.id !== id && Number(n.active) === 1 && Number(n.enabled) === 1
      );
      if (!alive.length) {
        return fail(
          res,
          409,
          "Tiene que quedar al menos un servidor encendido",
          "Enciende o agrega otro antes de eliminar este: si no, el Drive se queda sin nada que mostrar"
        );
      }
      if (!hasActive) {
        return fail(res, 400, MIGRATION_MISSING_ACTIVE, MIGRATION_HINT_ACTIVE);
      }
      await exec("UPDATE drive_nodes SET active = 0 WHERE id = ?", [id]);
      // El enlace era MUTUO: al eliminar un servidor, el otro extremo no puede
      // quedarse apuntando a uno que ya no existe. Sin esto quedaría bloqueado
      // para siempre y sin arreglo desde el panel (el modal solo ofrece
      // servidores vivos: no habría casilla que desmarcar).
      if (hasDepends) {
        for (const other of nodes) {
          if (other.id === id || !other.dependsOn.includes(id)) continue;
          await exec("UPDATE drive_nodes SET depends_on = ? WHERE id = ?", [
            dependsCsv(other.dependsOn.filter((dep) => dep !== id)),
            other.id,
          ]);
        }
      }
      const updated = (await listNodes()).find((n) => n.id === id) || null;
      await logActivity({
        userId: me.sub,
        module: "connection",
        moduleName: "Conexión",
        action: "delete",
        entity: "servidor del Drive",
        description: `Servidor del Drive eliminado (borrado lógico): ${row.name}`,
        details: { id, url: row.url, active: false },
        req,
      });
      return ok(res, "Servidor eliminado del panel", {
        id,
        active: 0,
        node: updated,
      });
    }

    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
  } catch (e) {
    console.error("[admin/drive-nodes]", e);
    fail(
      res,
      500,
      "Hubo un error",
      // Solo se manda a ejecutar la migración cuando de verdad falta: si no,
      // se enseña el error real de la base (código incluido) para poder
      // arreglarlo sin adivinar.
      `No se pudo ${verb} el servidor. ${
        isSchemaError(e) ? MIGRATION_HINT : dbDetail(e)
      }`
    );
  }
});
