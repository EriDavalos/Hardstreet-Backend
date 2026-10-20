import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import {
  requirePermission,
  requireAnyOfPermissions,
} from "../../../lib/permissions";
import { q, exec } from "../../../lib/db";
import { ok, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";
import { requestScope } from "../../../lib/company-scope";

// ==================================================================
// DISEÑO DEL SITIO (panel) -> /api/admin/site
//   GET   { design, landing }
//   PUT   { design?, landing? } -> guarda el diseño y/o la portada
//
// Es lo que hay detrás del DISEÑADOR del panel (tarjetas de paquetes y portada
// del sitio). Lo que se guarda aquí lo lee la web EN VIVO por /api/site.
//
//   design  → módulo "Paquetes"  (el diseñador de tarjetas vive ahí)
//   landing → módulo "Sitio web" (diseñador web, solo Windows)
//
// Los documentos se guardan COMPLETOS (el panel manda el objeto entero que
// armó): así no hay mezclas raras entre versiones del panel y de la web.
// Requiere la migración 2026-10-16_sitio_web.sql (tabla site_config).
// ==================================================================

type Doc = Record<string, unknown>;

const asDoc = (v: unknown): Doc | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Doc;
};

/**
 * Lee el documento de la EMPRESA. Tolerante: si la migración de Empresas
 * todavía no está, cae a la fila única de siempre.
 */
async function readRow(companyId: number): Promise<{ design: unknown; landing: unknown }> {
  try {
    const rows = await q<{ design: unknown; landing: unknown }>(
      "SELECT design, landing FROM site_config WHERE id_company = ? ORDER BY id ASC LIMIT 1",
      [companyId]
    );
    return rows[0] || { design: null, landing: null };
  } catch {
    const rows = await q<{ design: unknown; landing: unknown }>(
      "SELECT design, landing FROM site_config WHERE id = 1 LIMIT 1"
    );
    return rows[0] || { design: null, landing: null };
  }
}

// Tope del HTML propio de una sección (100 KB es de sobra para una sección;
// el tope evita que un pegado enorme infle el documento que baja la web).
const MAX_SECTION_HTML = 100_000;

/** Atributos que pueden llevar una URL (donde no vale `javascript:`). */
const URL_ATTRS = new Set([
  "href",
  "xlink:href",
  "src",
  "action",
  "formaction",
]);

/** HTML de una sección: sin <script> y con tope. null si queda vacío. */
function cleanHtml(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // El sitio lo pinta con innerHTML: un <script> pegado no se ejecuta al
  // asignarlo, pero se quita igual para que el documento no cargue código.
  // Tampoco pasan los manejadores en línea (`onclick`, `onerror`…) ni los
  // enlaces `javascript:`, que sí se ejecutarían dentro de la página pública.
  const code = v
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    // Los atributos se limpian SÓLO dentro de las etiquetas: si se aplicara al
    // texto entero, un párrafo como "Reserva online = 50%" perdería su texto.
    .replace(/<[a-z][^>]*>/gi, (tag) =>
      // Atributo por atributo (con su valor entre comillas de una pieza): así
      // no se toca lo que vaya DENTRO de un valor.
      tag.replace(
        // `[\s/]+`: `<svg/onload=…>` también trae un atributo `onload`.
        /[\s/]+([a-z_:][-a-z0-9_:.]*)(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/gi,
        (match, name: string, _assignment?: string, value?: string) => {
          const attr = name.toLowerCase();
          if (attr.startsWith("on")) return "";
          // `srcdoc` mete una página entera (con scripts) dentro de la
          // sección: no se permite.
          if (attr === "srcdoc") return "";
          if (URL_ATTRS.has(attr)) {
            const raw = (value || "").replace(/^["']|["']$/g, "").trim();
            if (/^javascript:/i.test(raw)) return "";
          }
          return match;
        }
      )
    )
    .trim();
  if (!code) return null;
  return code.slice(0, MAX_SECTION_HTML);
}

/**
 * Limpia el HTML propio del documento de la portada:
 *   html: { "hero": "<...>", "gallery-2": "<...>" }
 *   extraSections[i].html
 */
function sanitizeLanding(doc: Doc): Doc {
  const out: Doc = { ...doc };
  const raw = out.html;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const html: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const code = cleanHtml(value);
      if (code) html[key] = code;
    }
    out.html = html;
  }
  if (Array.isArray(out.extraSections)) {
    out.extraSections = out.extraSections.map((e) => {
      if (!e || typeof e !== "object" || Array.isArray(e)) return e;
      const copy = { ...(e as Doc) };
      if (copy.html !== undefined) {
        const code = cleanHtml(copy.html);
        if (code) copy.html = code;
        else delete copy.html;
      }
      return copy;
    });
  }
  return out;
}

/** Guarda los documentos de la empresa (la fila se crea si no existía). */
async function writeRow(
  patch: { design?: string; landing?: string },
  companyId: number
) {
  const fields: string[] = [];
  const params: unknown[] = [];
  if (patch.design !== undefined) {
    fields.push("`design` = ?");
    params.push(patch.design);
  }
  if (patch.landing !== undefined) {
    fields.push("`landing` = ?");
    params.push(patch.landing);
  }
  if (!fields.length) return;
  if (await hasCompanyColumn()) {
    await exec(
      `INSERT INTO site_config (id_company)
       SELECT ? WHERE NOT EXISTS (SELECT 1 FROM site_config WHERE id_company = ?)`,
      [companyId, companyId]
    );
    await exec(
      `UPDATE site_config SET ${fields.join(", ")} WHERE id_company = ?`,
      [...params, companyId]
    );
    return;
  }
  // Sin la migración de Empresas: fila única de siempre.
  await exec("INSERT INTO site_config (id) VALUES (1) ON DUPLICATE KEY UPDATE id = id");
  await exec(`UPDATE site_config SET ${fields.join(", ")} WHERE id = 1`, params);
}

/** ¿La columna `site_config.id_company` ya existe? (se pregunta una vez) */
let _companyColumn: boolean | null = null;
async function hasCompanyColumn(): Promise<boolean> {
  if (_companyColumn !== null) return _companyColumn;
  try {
    const rows = await q("SHOW COLUMNS FROM site_config LIKE 'id_company'");
    _companyColumn = rows.length > 0;
  } catch {
    _companyColumn = false;
  }
  return _companyColumn;
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  const body = (req.body || {}) as Doc;
  const design = asDoc(body.design);
  const landing = asDoc(body.landing);

  // Permiso por lo que se toca: las tarjetas son del módulo "Paquetes" y la
  // portada del módulo "Sitio web". Si se mandan los dos, se exigen los dos.
  let me: { sub: number; role: string } | null = null;
  if (req.method === "GET") {
    // El documento del sitio lo leen los DOS módulos que lo editan: las tarjetas
    // son de "Paquetes" y la portada de "Sitio web". Basta con poder ver uno.
    me = await requireAnyOfPermissions(req, res, [
      { module: "Paquetes", action: "read" },
      { module: "Sitio web", action: "read" },
    ]);
    if (!me) return;
  } else if (req.method === "PUT") {
    if (!design && !landing) {
      fail(
        res,
        400,
        "Nada que guardar",
        "Envía `design` (tarjetas) y/o `landing` (portada)"
      );
      return;
    }
    if (design) {
      me = await requirePermission(req, res, "Paquetes", "update");
      if (!me) return;
    }
    if (landing) {
      const forLanding = await requirePermission(req, res, "Sitio web", "update");
      if (!forLanding) return;
      me = me ?? forLanding;
    }
  } else {
    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
    return;
  }

  try {
    // Alcance por empresa: cada estudio tiene su propio sitio.
    const scope = await requestScope(req, me);
    const companyId = scope.writeCompanyId;

    if (req.method === "GET") {
      const row = await readRow(companyId);
      ok(res, "Diseño del sitio", { design: row.design, landing: row.landing });
      return;
    }

    await writeRow(
      {
        ...(design ? { design: JSON.stringify(design) } : {}),
        ...(landing ? { landing: JSON.stringify(sanitizeLanding(landing)) } : {}),
      },
      companyId
    );

    const row = await readRow(companyId);
    await logActivity({
      userId: me.sub,
      module: design ? "packages" : "settings",
      moduleName: design ? "Paquetes" : "Sitio web",
      action: "update",
      entity: "diseño del sitio",
      description: design
        ? "Diseño de tarjetas de paquetes actualizado"
        : "Contenido de la portada actualizado",
      details: { design: !!design, landing: !!landing },
      req,
    });
    ok(res, "Diseño guardado", { design: row.design, landing: row.landing });
  } catch (e) {
    console.error("[admin/site]", e);
    fail(
      res,
      500,
      "Hubo un error",
      "No se pudo guardar el diseño. ¿Ya aplicaste la migración 2026-10-16_sitio_web.sql?"
    );
  }
});
