// ==================================================================
// HARD STREET — Llevar el contenido ACTUAL de la web a la base de datos
// ==================================================================
// La tabla `site_config` (fila id = 1, columna `landing`) es de dónde la web
// lee la portada en vivo (GET /api/site). Mientras esté vacía, la web se pinta
// con lo que trae su propio HTML.
//
// Este script LEE lo que la web tiene ahora mismo —los textos y las imágenes de
// `index.html` y los fondos de `index.css`, más las opciones de fábrica de
// `gallery/assets/site.js`— y lo escribe como documento `landing`. Es el mismo
// documento que manda el panel con "Guardar lo actual en la base": a partir de
// ahí la base manda y el panel puede editar cada sección.
//
// Uso (desde Hardstreet-Backend, que es donde están mysql2 y el .env):
//
//   node tool/seed-site-content.mjs                 # lo guarda en la base
//   node tool/seed-site-content.mjs --dry-run       # sólo dice qué guardaría
//   node tool/seed-site-content.mjs --out x.json    # además deja el JSON
//   node tool/seed-site-content.mjs --web ../otro   # dónde está el sitio
//
// NO toca `design` (el diseño de las tarjetas de paquetes) ni borra nada: sólo
// escribe `landing`, y siempre desde lo que la web tiene ahora.
// ==================================================================

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.join(here, "..");

/** Argumentos simples: --clave valor / --bandera. */
function args(argv) {
  const out = { flags: new Set(), values: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out.values.set(name, next);
      i++;
    } else {
      out.flags.add(name);
    }
  }
  return out;
}

const cli = args(process.argv.slice(2));
const webDir = path.resolve(backendDir, cli.values.get("web") || "../Hardstreet");
const indexPath = path.join(webDir, "index.html");
const cssPath = path.join(webDir, "index.css");
const siteJsPath = path.join(webDir, "gallery", "assets", "site.js");

// ---------------------------------------------------------------
// 1. Leer la web
// ---------------------------------------------------------------

for (const file of [indexPath, cssPath, siteJsPath]) {
  if (!fs.existsSync(file)) {
    console.error(`No encuentro ${file}`);
    console.error("Pásame la carpeta del sitio con: --web <ruta>");
    process.exit(1);
  }
}

const html = fs.readFileSync(indexPath, "utf8");
const css = fs.readFileSync(cssPath, "utf8");

/** Las opciones de fábrica de cada sección, tal como las usa la web. */
function webSectionsDefaults() {
  const src = fs.readFileSync(siteJsPath, "utf8");
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: siteJsPath });
  return ctx.window.HSSite.sectionsDefaults;
}
const sectionsDefaults = webSectionsDefaults();

// ---------------------------------------------------------------
// 2. Textos (un valor por gancho `data-hs`)
// ---------------------------------------------------------------

const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&copy;": "©",
  "&reg;": "®",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
};

const decode = (s) =>
  String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&[a-z]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? e);

/**
 * Lo que hay DENTRO de la etiqueta que lleva ese gancho.
 *
 * Se cuentan las etiquetas del MISMO tipo para encontrar su cierre (un `</p>`
 * de dentro no cierra el `p` de fuera).
 */
function hookInner(value) {
  const open = new RegExp(
    `<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*\\bdata-hs="${value}"[^>]*>`,
    "i"
  );
  const m = open.exec(html);
  if (!m) return null;
  const tag = m[1];
  const start = m.index + m[0].length;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = start;
  let depth = 1;
  let mm;
  while ((mm = re.exec(html))) {
    if (mm[1] === "/") {
      depth--;
      if (depth === 0) return html.slice(start, mm.index);
    } else {
      depth++;
    }
  }
  return html.slice(start);
}

/**
 * El texto de un gancho, en el MISMO formato que guarda el panel:
 *   * `<br>` y `<em>` marcan la segunda línea → `|` (el panel lo escribe así);
 *   * el resto de etiquetas (`<span>`, `<em>`) se quitan;
 *   * se decodifican las entidades y se normalizan los espacios.
 */
function toText(inner) {
  return decode(
    String(inner)
      .replace(/<br\s*\/?>/gi, "|")
      .replace(/<em\b[^>]*>/gi, "|")
      .replace(/<[^>]*>/g, "")
  )
    .replace(/\s*\|\s*/g, "|")
    .replace(/\s+/g, " ")
    .trim();
}

const textKeys = [...html.matchAll(/data-hs="([^"]+)"/g)].map((m) => m[1]);
const texts = {};
for (const key of textKeys) {
  const inner = hookInner(key);
  if (inner === null) continue;
  const value = toText(inner);
  if (value) texts[key] = value;
}

// ---------------------------------------------------------------
// 3. Imágenes (un valor por gancho `data-hs-img`)
// ---------------------------------------------------------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** El fondo que el CSS le pone a esa clase (los fondos son `background: url()`). */
function cssBackgroundOf(classes) {
  for (const name of classes.split(/\s+/).filter(Boolean)) {
    const rules = css.matchAll(
      new RegExp(`\\.${escapeRe(name)}\\b[^{]*\\{([^}]*)\\}`, "gi")
    );
    for (const rule of rules) {
      const url = /background[^;]*url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(rule[1]);
      if (url) return url[1].trim();
    }
  }
  return null;
}

function imageOf(key) {
  const m = new RegExp(
    `<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*\\bdata-hs-img="${key}"[^>]*>`,
    "i"
  ).exec(html);
  if (!m) return null;
  const tag = m[1].toLowerCase();
  const attrs = m[0];
  if (tag === "img") {
    const src = /\bsrc="([^"]+)"/i.exec(attrs);
    return src ? src[1].trim() : null;
  }
  // No es una imagen: es un fondo (el hero y el divisor lo son), y su valor
  // vive en el CSS de su clase.
  const cls = /\bclass="([^"]+)"/i.exec(attrs);
  return cls ? cssBackgroundOf(cls[1]) : null;
}

const imageKeys = [...html.matchAll(/data-hs-img="([^"]+)"/g)].map((m) => m[1]);
const images = {};
for (const key of imageKeys) {
  const url = imageOf(key);
  if (url) images[key] = url;
}

// ---------------------------------------------------------------
// 4. Secciones: orden, visibilidad y opciones propias
// ---------------------------------------------------------------

const sectionKeys = [...html.matchAll(/data-hs-section="([^"]+)"/g)].map((m) => m[1]);

/** Los números de "Sobre nosotros" tal como están en la página. */
function aboutStats() {
  const counts = [...html.matchAll(/data-count="(\d+)"/g)].map((m) => Number(m[1]));
  const labels = [...html.matchAll(/class="stat-label"[^>]*>([^<]*)</g)].map((m) =>
    decode(m[1]).trim()
  );
  const out = [];
  counts.forEach((value, i) => {
    const label = labels[i] ?? "";
    if (value > 0 && label) out.push({ value, label });
  });
  return out;
}

const sections = {};
sectionKeys.forEach((key, i) => {
  const defaults = sectionsDefaults[key] || {};
  sections[key] = {
    visible: true,
    order: i + 1,
    props: JSON.parse(JSON.stringify(defaults)),
  };
});

// Lo que la PÁGINA muestra manda sobre el valor de fábrica del script: los
// números salen del propio HTML (si algún día cambian ahí, se copian igual).
const stats = aboutStats();
if (stats.length && sections.about) {
  sections.about.props.stats = stats;
}

const landing = { texts, images, sections };

// ---------------------------------------------------------------
// 5. Guardar (o no)
// ---------------------------------------------------------------

const outFile = cli.values.get("out");
if (outFile) {
  const target = path.resolve(process.cwd(), outFile);
  fs.writeFileSync(target, JSON.stringify(landing, null, 2) + "\n", "utf8");
  console.log(`Documento escrito en ${target}`);
}

const chars = JSON.stringify(landing).length;
console.log(
  `Contenido de la web: ${Object.keys(texts).length} textos, ` +
    `${Object.keys(images).length} imágenes, ${Object.keys(sections).length} secciones ` +
    `(${chars} caracteres de JSON).`
);
console.log(
  `  Ejemplos: hero_title = "${texts.hero_title ?? ""}" · ` +
    `contact_email = "${texts.contact_email ?? ""}" · ` +
    `hero_image = "${images.hero_image ?? ""}" · ` +
    `números = ${JSON.stringify(stats)}`
);

if (cli.flags.has("dry-run")) {
  console.log("(--dry-run: no se tocó la base de datos)");
  process.exit(0);
}

// Credenciales del backend (las mismas del .env que usa la API).
function readEnv() {
  const file = path.join(backendDir, ".env");
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const env = { ...readEnv(), ...process.env };
if (!env.MYSQL_HOST || !env.MYSQL_USER || !env.MYSQL_DATABASE) {
  console.error(
    "Faltan MYSQL_HOST / MYSQL_USER / MYSQL_DATABASE (revisa Hardstreet-Backend/.env)"
  );
  process.exit(1);
}

// mysql2 se carga AQUÍ (no arriba): así `--dry-run` funciona sin la dependencia.
const { default: mysql } = await import("mysql2/promise");

let conn;
try {
  conn = await mysql.createConnection({
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT || 3306),
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
  });

  // La fila única (id = 1) existe o se crea; `design` no se toca.
  await conn.query("INSERT INTO site_config (id) VALUES (1) ON DUPLICATE KEY UPDATE id = id");
  await conn.query("UPDATE site_config SET landing = ? WHERE id = 1", [
    JSON.stringify(landing),
  ]);

  const [rows] = await conn.query(
    "SELECT CHAR_LENGTH(COALESCE(landing, '')) AS len, updated FROM site_config WHERE id = 1"
  );
  const row = rows[0] || {};
  console.log(
    `Guardado en site_config.landing (id = 1): ${row.len} caracteres` +
      (row.updated ? ` · ${row.updated.toISOString?.() ?? row.updated}` : "")
  );
  console.log("La web ya lo lee al cargar (GET /api/site). No hace falta publicar nada.");
} catch (e) {
  console.error(`No se pudo guardar: ${e.code || e.message}`);
  process.exit(1);
} finally {
  if (conn) await conn.end();
}
