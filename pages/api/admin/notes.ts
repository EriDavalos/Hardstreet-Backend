import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { ok, created, fail } from "../../../lib/api-response";
import { q, exec } from "../../../lib/db";
import { logActivity } from "../../../lib/activity";
import { requestScope } from "../../../lib/company-scope";

// ==================================================================
// NOTAS -> /api/admin/notes
//
//   GET                 -> { notes: [{ id, title, preview, color, pinned,
//                                      updated, hasDrawing }] }
//   GET   ?id=N         -> { item: { id, title, blocks, visibility,
//                                    ownerId, ownerName, color, pinned,
//                                    created, updated } }
//   POST  { id?, title, blocks, visibility, color, pinned }
//                       -> crea (sin `id`) o actualiza la nota
//   DELETE ?id=N        -> baja lógica (la fila queda como historial)
//
// La nota guarda TRES cosas en la misma fila:
//   * `content` -> JSON de los BLOQUES: texto libre y listas de actividades
//                  con casilla  { blocks: [{ type: "text" | "checklist",
//                  text, items: [{ text, done }] }] }
//   * `drawing` -> JSON de los TRAZOS  { strokes: [{ color, width, eraser,
//                  points: [[x, y], ...] }] } con los puntos NORMALIZADOS
//                  (0..1), así el dibujo se ve igual en cualquier pantalla.
//   * `preview` -> primeras líneas del texto, para la tarjeta del listado.
//
// VISIBILIDAD: cada nota es «personal» (solo su autor) o «empresa» (la lee
// todo el equipo de la empresa). Solo el AUTOR edita o elimina la suya; las
// de la empresa que no son tuyas se abren en solo lectura.
// Permiso: módulo "notes" (Ver para leer; Crear/Editar/Eliminar para el resto).
// Sin la migración 2026-10-29 aplicada, el listado devuelve [] en vez de
// romper el módulo.
// ==================================================================

const MODULE = "notes";
const MODULE_NAME = "Notas";

const MAX_TITLE = 200;
const MAX_TEXT = 20000;
const MAX_BLOCKS = 300;
const MAX_ITEMS = 300;
const MAX_ITEM_TEXT = 500;
const MAX_STROKES = 800;
const MAX_POINTS = 4000;
/** Tope de cada JSON guardado (el cliente ya manda los trazos comprimidos). */
const MAX_JSON = 600_000;

type NoteBlock = {
  type: "text" | "checklist" | "drawing";
  text: string;
  items: { text: string; done: boolean }[];
  /** Solo en los bloques "drawing": el dibujo insertado en la nota. */
  strokes?: NoteStroke[];
};

type NoteStroke = {
  color: string;
  width: number;
  eraser: boolean;
  points: [number, number][];
};

/** Texto plano, sin recortar los saltos de línea del contenido. */
function text(v: unknown, max: number): string {
  return String(v ?? "").replace(/\r\n/g, "\n").slice(0, max);
}

/** Texto de una línea (título, nombre de actividad). */
function line(v: unknown, max: number): string {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Interpreta un JSON que puede venir como texto o ya como objeto. */
function jsonOf(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Bloques válidos (texto y listas de actividades). */
function parseBlocks(raw: unknown): NoteBlock[] {
  const data = jsonOf(raw);
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as { blocks?: unknown[] } | null)?.blocks)
      ? (data as { blocks: unknown[] }).blocks
      : [];
  const out: NoteBlock[] = [];
  for (const item of list.slice(0, MAX_BLOCKS)) {
    const b = (item ?? {}) as Record<string, unknown>;
    const rawType = String(b.type ?? "text").toLowerCase();
    // DIBUJO insertado en la nota: sus trazos viven EN el bloque.
    if (rawType === "drawing") {
      const strokes = parseDrawing(
        Array.isArray(b.strokes) ? b.strokes : b.drawing
      );
      out.push({ type: "drawing", text: "", items: [], strokes });
      continue;
    }
    const type = rawType === "checklist" ? "checklist" : "text";
    if (type === "text") {
      out.push({ type, text: text(b.text, MAX_TEXT), items: [] });
      continue;
    }
    const rawItems = Array.isArray(b.items) ? b.items : [];
    const items = rawItems.slice(0, MAX_ITEMS).map((it) => {
      const r = (it ?? {}) as Record<string, unknown>;
      return {
        text: line(r.text, MAX_ITEM_TEXT),
        done: r.done === true || Number(r.done) === 1,
      };
    });
    out.push({ type, text: "", items });
  }
  return out;
}

/** Trazos válidos: color hex, grosor acotado y puntos normalizados 0..1. */
function parseDrawing(raw: unknown): NoteStroke[] {
  const data = jsonOf(raw);
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as { strokes?: unknown[] } | null)?.strokes)
      ? (data as { strokes: unknown[] }).strokes
      : [];
  const out: NoteStroke[] = [];
  for (const item of list.slice(0, MAX_STROKES)) {
    const s = (item ?? {}) as Record<string, unknown>;
    const rawPoints = Array.isArray(s.points) ? s.points : [];
    const points: [number, number][] = [];
    for (const p of rawPoints.slice(0, MAX_POINTS)) {
      // Acepta [x, y] o { x, y } para no atarse al formato del panel.
      const pair = Array.isArray(p)
        ? p
        : [(p as Record<string, unknown> | null)?.x, (p as Record<string, unknown> | null)?.y];
      const x = Number(pair[0]);
      const y = Number(pair[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      points.push([
        Math.min(1, Math.max(0, Math.round(x * 10000) / 10000)),
        Math.min(1, Math.max(0, Math.round(y * 10000) / 10000)),
      ]);
    }
    if (!points.length) continue;
    const color = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(String(s.color ?? ""))
      ? String(s.color)
      : "#1F2937";
    const width = Math.min(24, Math.max(1, Number(s.width) || 3));
    out.push({ color, width, eraser: s.eraser === true, points });
  }
  return out;
}

/** Primeras líneas del texto: lo que se ve en la tarjeta del listado. */
/** Todos los trazos de la nota (los bloques de dibujo), en orden. */
function strokesOf(blocks: NoteBlock[]): NoteStroke[] {
  const out: NoteStroke[] = [];
  for (const b of blocks) {
    if (b.type !== "drawing") continue;
    for (const s of b.strokes ?? []) out.push(s);
  }
  return out;
}

function buildPreview(blocks: NoteBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "checklist") {
      for (const it of b.items) if (it.text) parts.push(it.text);
    } else if (b.text.trim()) {
      parts.push(b.text);
    }
    if (parts.join(" ").length > 280) break;
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 280);
}

/** Color de portada de la tarjeta. */
function parseColor(raw: unknown): string {
  const s = String(raw ?? "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : "";
}

function iso(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

type Row = Record<string, any>;

/** Nota completa tal como la consume el editor. */
function noteOf(r: Row) {
  return {
    id: Number(r.id),
    title: String(r.title || ""),
    blocks: parseBlocks(r.content),
    // Compatibilidad: el dibujo también viaja aparte (clientes viejos).
    strokes: parseDrawing(r.drawing),
    visibility: String(r.visibility || "private"),
    ownerId: Number(r.id_user || 0),
    ownerName: String(r.owner_name || ""),
    color: String(r.color || "").toUpperCase(),
    pinned: Number(r.pinned) === 1,
    created: iso(r.created),
    updated: iso(r.updated ?? r.created),
  };
}

/** La nota del usuario [userId] (o null si no existe / es de otro). */
async function ownedNote(
  id: number,
  userId: number
): Promise<Row | null> {
  const rows = await q<Row>(
    `SELECT n.id, n.title, n.content, n.drawing, n.color, n.pinned,
            n.visibility, n.id_user, n.created, n.updated,
            CONCAT_WS(' ', u.name, u.lastname) AS owner_name
       FROM notes n
       LEFT JOIN users u ON u.id = n.id_user
      WHERE n.id = ? AND n.id_user = ? AND n.active = 1
      LIMIT 1`,
    [id, userId]
  );
  return rows[0] ?? null;
}

/**
 * Nota que el usuario PUEDE ABRIR: la suya o una compartida con la empresa.
 * Si es de otro, viene marcada para abrirse en solo lectura.
 */
async function visibleNote(
  id: number,
  userId: number,
  companyId: number
): Promise<Row | null> {
  const rows = await q<Row>(
    `SELECT n.id, n.title, n.content, n.drawing, n.color, n.pinned,
            n.visibility, n.id_user, n.created, n.updated,
            CONCAT_WS(' ', u.name, u.lastname) AS owner_name
       FROM notes n
       LEFT JOIN users u ON u.id = n.id_user
      WHERE n.id = ? AND n.active = 1
        AND (n.id_user = ? OR (n.visibility = 'company' AND n.id_company = ?))
      LIMIT 1`,
    [id, userId, companyId]
  );
  return rows[0] ?? null;
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (!["GET", "POST", "DELETE"].includes(req.method || "")) {
    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
    return;
  }

  // ------------------------------- GET -------------------------------
  if (req.method === "GET") {
    const me = await requirePermission(req, res, MODULE, "read");
    if (!me) return;

    const id = Number(req.query.id || 0);
    // Empresa con la que se trabaja: con ella se ven las notas compartidas
    // con la empresa (las personales solo las ve su autor).
    const scope = await requestScope(req, me);
    const companyId = scope.companyId ?? scope.writeCompanyId;
    try {
      if (id) {
        const row = await visibleNote(id, me.sub, companyId);
        if (!row) {
          fail(res, 404, "Nota no encontrada", `No hay una nota ${id} tuya`);
          return;
        }
        ok(res, "Nota", { item: noteOf(row) });
        return;
      }
      const rows = await q<Row>(
        `SELECT n.id, n.title, n.preview, n.color, n.pinned, n.visibility,
                n.id_user, u.name AS owner_name, u.lastname AS owner_lastname,
                DATE_FORMAT(COALESCE(n.updated, n.created), '%Y-%m-%dT%H:%i:%s') AS updated,
                -- 'hasDrawing': solo si hay TRAZOS (una nota guardada sin
                -- dibujo queda como {"strokes":[]} y no debe marcarse).
                CASE
                  WHEN n.drawing IS NULL
                       OR n.drawing = ''
                       OR n.drawing = '{"strokes":[]}'
                  THEN 0 ELSE 1
                END AS has_drawing
           FROM notes n
           LEFT JOIN users u ON u.id = n.id_user
          WHERE n.active = 1
            AND (n.id_user = ?
                 OR (n.visibility = 'company' AND n.id_company = ?))
          ORDER BY n.pinned DESC, COALESCE(n.updated, n.created) DESC, n.id DESC`,
        [me.sub, companyId]
      );
      ok(res, "Notas", {
        notes: rows.map((r) => ({
          id: Number(r.id),
          title: String(r.title || ""),
          preview: String(r.preview || ""),
          color: String(r.color || "").toUpperCase(),
          pinned: Number(r.pinned) === 1,
          updated: iso(r.updated),
          hasDrawing: Number(r.has_drawing) === 1,
          visibility: String(r.visibility || "private"),
          mine: Number(r.id_user) === me.sub,
          ownerId: Number(r.id_user || 0),
          ownerName: String(
            [r.owner_name, r.owner_lastname].filter(Boolean).join(" ")
          ).trim(),
        })),
      });
    } catch (e) {
      console.error("[admin/notes] GET:", e);
      // Migración pendiente: el módulo abre vacío en vez de romperse.
      if (!id) ok(res, "Notas", { notes: [] });
      else fail(res, 500, "Hubo un error", "No se pudo leer la nota");
    }
    return;
  }

  // ------------------------------ DELETE ------------------------------
  if (req.method === "DELETE") {
    const me = await requirePermission(req, res, MODULE, "delete");
    if (!me) return;
    const id = Number(req.query.id || 0);
    if (!id) {
      fail(res, 400, "Falta la nota", "Indica qué nota quieres eliminar");
      return;
    }
    try {
      const r = await exec(
        `UPDATE notes SET active = 0, updated = NOW()
          WHERE id = ? AND id_user = ? AND active = 1`,
        [id, me.sub]
      );
      if (!r.affectedRows) {
        fail(res, 404, "Nota no encontrada", `No hay una nota ${id} tuya`);
        return;
      }
      await logActivity({
        userId: me.sub,
        module: MODULE,
        moduleName: MODULE_NAME,
        action: "delete",
        entity: "nota",
        entityId: id,
        description: "Nota eliminada exitosamente",
        details: { id },
        req,
      });
      ok(res, "Nota eliminada exitosamente", { item: { id } });
    } catch (e) {
      console.error("[admin/notes] DELETE:", e);
      fail(res, 500, "Hubo un error", "No se pudo eliminar la nota");
    }
    return;
  }

  // ------------------------------- POST ------------------------------
  const body = (req.body || {}) as Record<string, unknown>;
  const id = Number(body.id || 0);
  // Crear y editar son permisos distintos: se pide el que toca.
  const me = await requirePermission(
    req,
    res,
    MODULE,
    id > 0 ? "update" : "create"
  );
  if (!me) return;

  const title = line(body.title, MAX_TITLE);
  const blocks = parseBlocks(body.blocks);
  // El dibujo vive en su BLOQUE dentro de la nota; también se guarda en la
  // columna `drawing` para que el listado marque «tiene dibujo» sin abrir el
  // contenido (y para que un cliente viejo siga viéndolo).
  const legacyStrokes = parseDrawing(body.drawing);
  if (!blocks.some((b) => b.type === "drawing") && legacyStrokes.length) {
    blocks.push({
      type: "drawing",
      text: "",
      items: [],
      strokes: legacyStrokes,
    });
  }
  const strokes = strokesOf(blocks);
  // PERSONAL (solo el autor) o EMPRESA (todo el equipo de la empresa).
  const visibility = body.visibility === "company" ? "company" : "private";
  const color = parseColor(body.color);
  const pinned = body.pinned === true || Number(body.pinned) === 1;
  const content = JSON.stringify({ blocks });
  const drawing = JSON.stringify({ strokes });
  if (content.length > MAX_JSON || drawing.length > MAX_JSON) {
    fail(
      res,
      413,
      "La nota es demasiado grande",
      "Reduce el dibujo o el texto y vuelve a guardar"
    );
    return;
  }
  if (!title && !blocks.some((b) => b.text.trim() || b.items.length) && !strokes.length) {
    fail(
      res,
      400,
      "La nota está vacía",
      "Escribe un título, texto o dibuja algo antes de guardar"
    );
    return;
  }
  const preview = buildPreview(blocks);

  try {
    if (id > 0) {
      const current = await ownedNote(id, me.sub);
      if (!current) {
        fail(res, 404, "Nota no encontrada", `No hay una nota ${id} tuya`);
        return;
      }
      await exec(
        `UPDATE notes
            SET title = ?, preview = ?, content = ?, drawing = ?, color = ?,
                pinned = ?, visibility = ?, updated = NOW()
          WHERE id = ? AND id_user = ? AND active = 1`,
        [
          title || null,
          preview || null,
          content,
          drawing,
          color || null,
          pinned ? 1 : 0,
          visibility,
          id,
          me.sub,
        ]
      );
      await logActivity({
        userId: me.sub,
        module: MODULE,
        moduleName: MODULE_NAME,
        action: "update",
        entity: "nota",
        entityId: id,
        description: "Nota actualizada exitosamente",
        details: { id, title },
        req,
      });
      const saved = await ownedNote(id, me.sub);
      ok(res, "Nota guardada exitosamente", {
        item: saved ? noteOf(saved) : null,
      });
      return;
    }

    const scope = await requestScope(req, me);
    const r = await exec(
      `INSERT INTO notes
         (id_user, id_company, title, preview, content, drawing, color, pinned,
          visibility, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        me.sub,
        scope.writeCompanyId,
        title || null,
        preview || null,
        content,
        drawing,
        color || null,
        pinned ? 1 : 0,
        visibility,
      ]
    );
    await logActivity({
      userId: me.sub,
      module: MODULE,
      moduleName: MODULE_NAME,
      action: "create",
      entity: "nota",
      entityId: r.insertId,
      description: "Nota creada exitosamente",
      details: { id: r.insertId, title },
      req,
    });
    const saved = await ownedNote(r.insertId, me.sub);
    created(res, "Nota creada exitosamente", {
      item: saved ? noteOf(saved) : null,
    });
  } catch (e) {
    console.error("[admin/notes] POST:", e);
    fail(
      res,
      409,
      "No se pudo guardar la nota",
      "Falta aplicar la migración del módulo Notas (2026-10-29 y su visibilidad)"
    );
  }
});
