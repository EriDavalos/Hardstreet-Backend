import type { NextApiRequest, NextApiResponse } from "next";
import { randomBytes } from "crypto";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { ok, created, fail } from "../../../lib/api-response";
import { q, exec } from "../../../lib/db";
import { logActivity } from "../../../lib/activity";
import { requestScope } from "../../../lib/company-scope";

// ==================================================================
// INVITACIONES -> /api/admin/invitations
//
//   GET                 -> { invitations: [{ ...sin html }] }
//   GET   ?id=N         -> { item: { ...sin html } }
//   POST  { ...campos } -> crea (la liga pública se crea al publicar)
//   PUT   { id, ... }   -> actualiza (publicar/despublicar incluido)
//   DELETE ?id=N        -> baja lógica (la fila queda como historial)
//
// QUÉ SE GUARDA:
//   · el DISEÑO (`template`, `accent`, `font`), los TEXTOS y las FOTOS,
//     para poder volver a editar la invitación;
//   · el HTML ya renderizado (`html`) que genera el panel. Ese HTML es el
//     que se sirve en la liga pública /i/<slug> (ver
//     pages/api/invitations/public.ts), así que el cliente ve EXACTAMENTE
//     lo que el panel previsualizó. El backend no re-renderiza nada.
//
// EMPRESA: cada empresa ve solo sus invitaciones. El Superadmin puede mirar
// las de todas (sin `X-Company-Id`) y crea en la empresa con la que trabaja.
//
// Permiso: módulo "invitations" (Ver para leer; Crear/Editar/Eliminar para
// el resto). Sin la migración aplicada, el listado devuelve [] en vez de
// romper el módulo.
// ==================================================================

const MODULE = "invitations";
const MODULE_NAME = "Invitaciones";

/** Plantillas conocidas (las mismas claves que usa el panel). */
const TEMPLATES = new Set([
  "xv-elegancia",
  "xv-rosa",
  "boda-clasica",
  "boda-jardin",
  "cumple-pop",
  "cumple-dulce",
]);

/** Familias tipográficas que ofrece el diseñador. */
const FONTS = new Set(["clasica", "moderna", "romantica"]);

const MAX_HTML = 300_000;
const MAX_PHOTOS = 6;

type Row = Record<string, unknown>;

/** Texto de una línea (título, nombres, lugar…). */
function line(v: unknown, max: number): string {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Texto libre, conservando los saltos de línea. */
function text(v: unknown, max: number): string {
  return String(v ?? "").replace(/\r\n/g, "\n").slice(0, max);
}

/** Color de acento válido (`#RRGGBB`) o "" para usar el de la plantilla. */
function parseColor(raw: unknown): string {
  const s = String(raw ?? "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : "";
}

/** Fotos: solo http(s) y sin duplicados. */
function parsePhotos(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string" && raw.trim()
      ? (() => {
          try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : [];
  const out: string[] = [];
  for (const item of list) {
    const url = String(item ?? "").trim();
    if (!/^https?:\/\//i.test(url) || url.length > 1000) continue;
    if (!out.includes(url)) out.push(url);
    if (out.length >= MAX_PHOTOS) break;
  }
  return out;
}

/** Fecha ISO corta para la app (o null si no hay). */
function iso(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** Fila de la API (sin el HTML, que solo usa la liga pública). */
function itemOf(r: Row) {
  return {
    id: Number(r.id),
    title: String(r.title ?? ""),
    template: String(r.template ?? ""),
    occasion: String(r.occasion ?? ""),
    headline: String(r.headline ?? ""),
    subheadline: String(r.subheadline ?? ""),
    dateText: String(r.date_text ?? ""),
    timeText: String(r.time_text ?? ""),
    placeName: String(r.place_name ?? ""),
    placeAddress: String(r.place_address ?? ""),
    message: String(r.message ?? ""),
    dressCode: String(r.dress_code ?? ""),
    rsvpPhone: String(r.rsvp_phone ?? ""),
    accent: String(r.accent ?? "").toUpperCase(),
    font: String(r.font ?? ""),
    photos: parsePhotos(r.photos),
    slug: String(r.slug ?? ""),
    published: Number(r.published) === 1,
    created: iso(r.created),
    updated: iso(r.updated_iso ?? r.updated ?? r.created),
  };
}

const SELECT_COLS = `i.id, i.title, i.template, i.occasion, i.headline,
  i.subheadline, i.date_text, i.time_text, i.place_name, i.place_address,
  i.message, i.dress_code, i.rsvp_phone, i.accent, i.font, i.photos, i.slug,
  i.published, i.created,
  DATE_FORMAT(COALESCE(i.updated, i.created), '%Y-%m-%dT%H:%i:%s') AS updated_iso`;

/** La invitación [id] visible en [companyId] (null pide todas). */
async function visibleInvitation(
  id: number,
  companyId: number | null
): Promise<Row | null> {
  const params: unknown[] = [id];
  let sql = `SELECT ${SELECT_COLS}, i.html
               FROM invitations i
              WHERE i.id = ? AND i.active = 1`;
  if (companyId != null) {
    sql += " AND i.id_company = ?";
    params.push(companyId);
  }
  sql += " LIMIT 1";
  const rows = await q<Row>(sql, params);
  return rows[0] ?? null;
}

/**
 * Liga pública de la invitación: 12 caracteres hex aleatorios.
 *
 * Se crea la primera vez que se publica (o al guardar ya publicada) y NO
 * cambia al editar: la liga que ya se mandó al cliente sigue sirviendo. Si
 * el rol no llegara a tener `slug` (fila vieja), se genera aquí.
 */
async function ensureSlug(id: number, current: unknown): Promise<string> {
  const existing = String(current ?? "").trim();
  if (existing) return existing;
  for (let i = 0; i < 6; i++) {
    const slug = randomBytes(6).toString("hex");
    const taken = await q<{ id: number }>(
      "SELECT id FROM invitations WHERE slug = ? LIMIT 1",
      [slug]
    );
    if (!taken.length) {
      await exec("UPDATE invitations SET slug = ? WHERE id = ?", [slug, id]);
      return slug;
    }
  }
  // Respaldo improbable: el id hace único el valor.
  const slug = `${randomBytes(4).toString("hex")}${id.toString(36)}`.slice(0, 40);
  await exec("UPDATE invitations SET slug = ? WHERE id = ?", [slug, id]);
  return slug;
}

/** ¿El error es de ESQUEMA (falta la migración)? */
function isMissingTable(e: unknown): boolean {
  const code = String((e as { code?: string })?.code || "");
  return (
    code === "ER_NO_SUCH_TABLE" ||
    code === "ER_BAD_FIELD_ERROR" ||
    code === "ER_UNKNOWN_COLUMN"
  );
}

const MIGRATION_HINT =
  "Ejecuta Hardstreet-DB/2026-10-30_modulo_invitaciones.sql en la base del panel y vuelve a intentar";

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (!["GET", "POST", "PUT", "DELETE"].includes(req.method || "")) {
    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
    return;
  }

  // ------------------------------- GET -------------------------------
  if (req.method === "GET") {
    const me = await requirePermission(req, res, MODULE, "read");
    if (!me) return;

    const id = Number(req.query.id || 0);
    const scope = await requestScope(req, me);
    try {
      if (id) {
        const row = await visibleInvitation(id, scope.companyId);
        if (!row) {
          fail(res, 404, "Invitación no encontrada", `No existe la invitación ${id}`);
          return;
        }
        ok(res, "Invitación", { item: itemOf(row) });
        return;
      }
      const params: unknown[] = [];
      let sql = `SELECT ${SELECT_COLS}
                   FROM invitations i
                  WHERE i.active = 1`;
      if (scope.companyId != null) {
        sql += " AND i.id_company = ?";
        params.push(scope.companyId);
      }
      sql += ` ORDER BY COALESCE(i.updated, i.created) DESC, i.id DESC`;
      const rows = await q<Row>(sql, params);
      ok(res, "Invitaciones", {
        invitations: rows.map(itemOf),
        // El panel lo usa para explicar por qué está vacío sin romper.
        ready: true,
      });
    } catch (e) {
      console.error("[admin/invitations] GET:", e);
      if (!id) {
        ok(res, "Invitaciones", {
          invitations: [],
          ready: false,
          hint: MIGRATION_HINT,
        });
      } else {
        fail(res, 500, "Hubo un error", "No se pudo leer la invitación");
      }
    }
    return;
  }

  // ------------------------------ DELETE ------------------------------
  if (req.method === "DELETE") {
    const me = await requirePermission(req, res, MODULE, "delete");
    if (!me) return;
    const id = Number(req.query.id || 0);
    if (!id) {
      fail(res, 400, "Falta la invitación", "Indica qué invitación quieres eliminar");
      return;
    }
    const scope = await requestScope(req, me);
    try {
      const current = await visibleInvitation(id, scope.companyId);
      if (!current) {
        fail(res, 404, "Invitación no encontrada", `No existe la invitación ${id}`);
        return;
      }
      await exec(
        "UPDATE invitations SET active = 0, published = 0 WHERE id = ?",
        [id]
      );
      await logActivity({
        userId: me.sub,
        module: MODULE,
        moduleName: MODULE_NAME,
        action: "delete",
        entity: "invitación",
        entityId: id,
        description: "Invitación eliminada",
        details: { id, title: String(current.title ?? "") },
        req,
      });
      ok(res, "Invitación eliminada", { item: { id } });
    } catch (e) {
      console.error("[admin/invitations] DELETE:", e);
      fail(
        res,
        500,
        "No se pudo eliminar la invitación",
        isMissingTable(e) ? MIGRATION_HINT : "La base rechazó la operación"
      );
    }
    return;
  }

  // --------------------------- POST / PUT ----------------------------
  const body = (req.body || {}) as Record<string, unknown>;
  const id = Number(body.id || 0);
  const editing = req.method === "PUT" || id > 0;
  const me = await requirePermission(
    req,
    res,
    MODULE,
    editing ? "update" : "create"
  );
  if (!me) return;

  const scope = await requestScope(req, me);

  try {
    if (editing) {
      if (!id) {
        fail(res, 400, "Falta la invitación", "Indica qué invitación vas a editar");
        return;
      }
      const current = await visibleInvitation(id, scope.companyId);
      if (!current) {
        fail(res, 404, "Invitación no encontrada", `No existe la invitación ${id}`);
        return;
      }

      const fields: string[] = [];
      const params: unknown[] = [];
      const set = (column: string, value: unknown) => {
        fields.push(`${column} = ?`);
        params.push(value);
      };

      if (body.title !== undefined) set("title", line(body.title, 160));
      if (body.template !== undefined) {
        const template = String(body.template ?? "").trim();
        set("template", TEMPLATES.has(template) ? template : "xv-elegancia");
      }
      if (body.occasion !== undefined) set("occasion", line(body.occasion, 40));
      if (body.headline !== undefined) set("headline", line(body.headline, 160));
      if (body.subheadline !== undefined) {
        set("subheadline", line(body.subheadline, 160));
      }
      if (body.dateText !== undefined) set("date_text", line(body.dateText, 120));
      if (body.timeText !== undefined) set("time_text", line(body.timeText, 60));
      if (body.placeName !== undefined) {
        set("place_name", line(body.placeName, 160));
      }
      if (body.placeAddress !== undefined) {
        set("place_address", line(body.placeAddress, 255));
      }
      if (body.message !== undefined) set("message", text(body.message, 4000));
      if (body.dressCode !== undefined) {
        set("dress_code", line(body.dressCode, 120));
      }
      if (body.rsvpPhone !== undefined) {
        set("rsvp_phone", line(body.rsvpPhone, 40));
      }
      if (body.accent !== undefined) set("accent", parseColor(body.accent));
      if (body.font !== undefined) {
        const font = String(body.font ?? "").trim();
        set("font", FONTS.has(font) ? font : "");
      }
      if (body.photos !== undefined) {
        set("photos", JSON.stringify(parsePhotos(body.photos)));
      }
      if (body.html !== undefined) {
        const html = text(body.html, MAX_HTML);
        if (html.trim().length < 50) {
          fail(
            res,
            400,
            "Falta la vista previa de la invitación",
            "El panel genera el HTML al guardar: vuelve a intentarlo"
          );
          return;
        }
        set("html", html);
      }

      let published = Number(current.published) === 1;
      if (body.published !== undefined) {
        published = body.published === true || Number(body.published) === 1;
        set("published", published ? 1 : 0);
      }
      if (published) {
        const stored = String(current.html ?? "").trim();
        if (!fields.length) {
          fail(res, 400, "Nada que guardar");
          return;
        }
        // Publicar exige que haya algo que servir: el HTML nuevo o el guardado.
        const sendsHtml = body.html !== undefined;
        if (!sendsHtml && stored.length < 50) {
          fail(
            res,
            400,
            "Todavía no hay nada que publicar",
            "Guarda la invitación con su diseño antes de publicarla"
          );
          return;
        }
      }
      if (!fields.length) {
        fail(res, 400, "Nada que guardar");
        return;
      }

      await exec(
        `UPDATE invitations SET ${fields.join(", ")} WHERE id = ? AND active = 1`,
        [...params, id]
      );
      const slug = published
        ? await ensureSlug(id, current.slug)
        : String(current.slug ?? "");
      const saved = await visibleInvitation(id, scope.companyId);
      await logActivity({
        userId: me.sub,
        module: MODULE,
        moduleName: MODULE_NAME,
        action: "update",
        entity: "invitación",
        entityId: id,
        description: `Invitación actualizada: ${String(
          saved?.title ?? current.title ?? ""
        )}`,
        details: {
          id,
          published,
          template: String(saved?.template ?? ""),
        },
        req,
      });
      ok(res, published ? "Invitación publicada" : "Invitación guardada", {
        item: saved ? { ...itemOf(saved), slug } : null,
        slug,
        published,
      });
      return;
    }

    // ------------------------------ CREAR ------------------------------
    const title = line(body.title, 160);
    const headline = line(body.headline, 160);
    if (!title && !headline) {
      fail(
        res,
        400,
        "Falta el nombre de la invitación",
        "Escribe el título o los nombres del evento"
      );
      return;
    }
    const templateRaw = String(body.template ?? "").trim();
    const template = TEMPLATES.has(templateRaw) ? templateRaw : "xv-elegancia";
    const html = text(body.html, MAX_HTML);
    if (html.trim().length < 50) {
      fail(
        res,
        400,
        "Falta la vista previa de la invitación",
        "El panel genera el HTML al guardar: vuelve a intentarlo"
      );
      return;
    }
    const published =
      body.published === true || Number(body.published) === 1;

    const r = await exec(
      `INSERT INTO invitations
         (id_company, id_user, title, template, occasion, headline, subheadline,
          date_text, time_text, place_name, place_address, message, dress_code,
          rsvp_phone, accent, font, photos, html, published, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        scope.writeCompanyId,
        me.sub,
        title || headline,
        template,
        line(body.occasion, 40),
        headline || title,
        line(body.subheadline, 160),
        line(body.dateText, 120),
        line(body.timeText, 60),
        line(body.placeName, 160),
        line(body.placeAddress, 255),
        text(body.message, 4000),
        line(body.dressCode, 120),
        line(body.rsvpPhone, 40),
        parseColor(body.accent),
        FONTS.has(String(body.font ?? "").trim())
          ? String(body.font).trim()
          : "",
        JSON.stringify(parsePhotos(body.photos)),
        html,
        published ? 1 : 0,
      ]
    );
    const slug = published ? await ensureSlug(r.insertId, "") : "";
    const saved = await visibleInvitation(r.insertId, scope.companyId);
    await logActivity({
      userId: me.sub,
      module: MODULE,
      moduleName: MODULE_NAME,
      action: "create",
      entity: "invitación",
      entityId: r.insertId,
      description: `Invitación creada: ${title || headline}`,
      details: { id: r.insertId, template, published },
      req,
    });
    created(res, "Invitación creada", {
      item: saved ? { ...itemOf(saved), slug } : null,
      slug,
      published,
    });
  } catch (e) {
    console.error("[admin/invitations] POST/PUT:", e);
    fail(
      res,
      500,
      "No se pudo guardar la invitación",
      isMissingTable(e)
        ? MIGRATION_HINT
        : "La base rechazó la operación (revisa que la migración esté aplicada)"
    );
  }
});
