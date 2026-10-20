// ==================================================================
// HARD STREET BACKEND - Impresiones
// ==================================================================
// Tablas (migración 2026-10-19_impresiones.sql):
//
//   print_formats        formatos de impresión: nombre + medidas (5x7, 1x1…)
//   print_requests       un ENVÍO del cliente para un servicio del paquete
//                        status: sent (enviado, bloqueado) | finished
//   print_requests_items las fotos que viajaron en ese envío
//
// Reglas:
//   * El cliente envía la selección que ya tenía en «Mi paquete». Mientras
//     exista un envío activo (sent/finished) NO puede cambiarla.
//   * El estudio ve los envíos agrupados por servicio con su cliente y sus
//     fotos, elige formato y da «Terminar» (bloquea el formato). «Reabrir»
//     desactiva el envío y vuelve a habilitar al cliente.
//   * Sin la migración aplicada estas consultas devuelven listas vacías en
//     vez de tumbar la petición (el panel sigue funcionando).
// ==================================================================

import { q, exec, transaccion } from "./db";
import { normalizeDrivePath } from "./drive-paths";

export type PrintStatus = "sent" | "finished";

export interface PrintFormat {
  id: number;
  name: string;
  width: number;
  height: number;
  unit: string;
  order: number | null;
}

/// Ajuste de recorte de UNA foto (lo mismo que `PrintCrop` del panel).
///
///   x, y    centro del recorte dentro de la foto (0..1)
///   zoom    1 = recorte máximo, 8 = ocho veces más cerca
///   landscape  true/false = orientación elegida; null = automática
///
/// Se guarda por RUTA, así el estudio recupera el encuadre de cada foto la
/// próxima vez que abra el formato, sin volver a ajustarlo.
export interface PrintCropEntry {
  x: number;
  y: number;
  zoom: number;
  landscape: boolean | null;
}

export interface PrintRequest {
  id: number;
  serviceId: number;
  clientId: number | null;
  clientName: string;
  packageName: string;
  serviceName: string;
  status: PrintStatus;
  formatId: number | null;
  formatName: string;
  border: number;
  sentAt: string;
  finishedAt: string;
  photos: string[];
  crops: Record<string, PrintCropEntry>;
}

export interface PrintRequestState {
  id: number;
  status: PrintStatus;
  formatId: number | null;
  border: number;
}

function norm(v: unknown): string {
  return String(v ?? "").trim();
}

function asNumber(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

/**
 * Normaliza el mapa de posiciones que manda el panel.
 *
 * Se aceptan solo rutas del Drive (normalizadas) y números dentro de rango;
 * lo que no encaje se descarta en vez de romper el guardado. El límite de
 * 2000 fotos evita que una petición enorme llene la fila.
 */
export function sanitizePrintCrops(
  value: unknown
): Record<string, PrintCropEntry> {
  const out: Record<string, PrintCropEntry> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  let n = 0;
  for (const [rawPath, raw] of Object.entries(value as Record<string, unknown>)) {
    if (n >= 2000) break;
    const path = normalizeDrivePath(rawPath);
    if (!path || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const c = raw as Record<string, unknown>;
    out[path] = {
      x: clamp(asNumber(c.x, 0.5), 0, 1),
      y: clamp(asNumber(c.y, 0.5), 0, 1),
      zoom: clamp(asNumber(c.zoom, 1), 1, 8),
      landscape:
        c.landscape === true ? true : c.landscape === false ? false : null,
    };
    n++;
  }
  return out;
}

/** Lee la columna `crops` (TEXT con JSON). Nunca lanza. */
export function parsePrintCrops(raw: unknown): Record<string, PrintCropEntry> {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
  if (typeof text !== "string" || !text.trim()) return {};
  try {
    return sanitizePrintCrops(JSON.parse(text));
  } catch {
    return {};
  }
}

/** ¿El error es "esa columna no existe" (migración pendiente)? */
function missingColumn(e: unknown): boolean {
  const err = e as { code?: string; errno?: number; message?: string };
  return (
    err?.code === "ER_BAD_FIELD_ERROR" ||
    err?.errno === 1054 ||
    /unknown column/i.test(err?.message || "")
  );
}

/** Formatos activos, en el orden que fijó el estudio. */
export async function printFormats(): Promise<PrintFormat[]> {
  try {
    const rows = await q<any>(
      `SELECT id, name, width, height, unit, \`order\`
         FROM print_formats
        WHERE active = 1
        ORDER BY \`order\` ASC, id ASC`
    );
    return rows.map((r) => ({
      id: asNumber(r.id),
      name: norm(r.name),
      width: asNumber(r.width),
      height: asNumber(r.height),
      unit: norm(r.unit) || "in",
      order: r.order === null ? null : asNumber(r.order),
    }));
  } catch {
    return []; // migración pendiente
  }
}

/**
 * Crea (o renombra) un formato. El nombre es la identidad visible ("12x18"):
 * si ya existe se actualizan sus medidas en vez de duplicarlo.
 */
export async function savePrintFormat(input: {
  name: string;
  width: number;
  height: number;
  unit?: string;
}): Promise<PrintFormat> {
  const name = norm(input.name);
  const width = asNumber(input.width);
  const height = asNumber(input.height);
  if (!name || width <= 0 || height <= 0) {
    throw Object.assign(new Error("Indica el nombre y las medidas del formato"), {
      status: 400,
    });
  }
  const unit = norm(input.unit).toLowerCase() === "cm" ? "cm" : "in";
  const existing = await q<{ id: number }>(
    `SELECT id FROM print_formats WHERE LOWER(name) = LOWER(?) LIMIT 1`,
    [name]
  );
  if (existing.length) {
    await exec(
      `UPDATE print_formats SET width = ?, height = ?, unit = ?, active = 1
        WHERE id = ?`,
      [width, height, unit, existing[0].id]
    );
    const all = await printFormats();
    return all.find((f) => f.id === existing[0].id) ?? all[0];
  }
  const order = await q<{ next: number }>(
    `SELECT COALESCE(MAX(\`order\`), 0) + 1 AS next FROM print_formats`
  );
  const r = await exec(
    `INSERT INTO print_formats (name, width, height, unit, \`order\`, active)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [name, width, height, unit, order[0]?.next ?? 1]
  );
  const all = await printFormats();
  return all.find((f) => f.id === r.insertId) ?? all[all.length - 1];
}

/** Baja lógica de un formato (los envíos ya cerrados conservan su nombre). */
export async function deletePrintFormat(id: number): Promise<void> {
  await exec(`UPDATE print_formats SET active = 0 WHERE id = ?`, [id]);
}

/**
 * Envío ACTIVO de un servicio (el que bloquea la selección del cliente).
 * Devuelve null si no hay migración o no hay envío.
 */
export async function servicePrintRequest(
  serviceId: number
): Promise<PrintRequestState | null> {
  try {
    const rows = await q<any>(
      `SELECT id, status, id_format, border
         FROM print_requests
        WHERE id_purchased_package_service = ? AND active = 1
        ORDER BY id DESC
        LIMIT 1`,
      [serviceId]
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: asNumber(r.id),
      status: norm(r.status) === "finished" ? "finished" : "sent",
      formatId: r.id_format === null ? null : asNumber(r.id_format),
      border: asNumber(r.border),
    };
  } catch {
    return null;
  }
}

/** ¿La selección del servicio está bloqueada por un envío? */
export async function servicePrintLocked(
  serviceId: number
): Promise<PrintRequestState | null> {
  return servicePrintRequest(serviceId);
}

/** Estado de impresión de VARIOS servicios (una sola consulta). */
export async function servicePrintStates(
  serviceIds: number[]
): Promise<Map<number, PrintRequestState>> {
  const ids = [...new Set(serviceIds.map((n) => Number(n)).filter((n) => n > 0))];
  const out = new Map<number, PrintRequestState>();
  if (!ids.length) return out;
  try {
    const rows = await q<any>(
      `SELECT r.id, r.id_purchased_package_service AS serviceId,
              r.status, r.id_format, r.border
         FROM print_requests r
         JOIN (
           SELECT MAX(id) AS id
             FROM print_requests
            WHERE active = 1 AND id_purchased_package_service IN (?)
            GROUP BY id_purchased_package_service
         ) latest ON latest.id = r.id`,
      [ids]
    );
    for (const r of rows) {
      out.set(asNumber(r.serviceId), {
        id: asNumber(r.id),
        status: norm(r.status) === "finished" ? "finished" : "sent",
        formatId: r.id_format === null ? null : asNumber(r.id_format),
        border: asNumber(r.border),
      });
    }
  } catch {
    // Migración pendiente: sin envíos.
  }
  return out;
}

/**
 * Crea el envío con las rutas indicadas y deja INACTIVOS los anteriores del
 * mismo servicio (si quedara alguno por una reapertura a medias).
 */
export async function createPrintRequest(args: {
  serviceId: number;
  userId: number;
  paths: string[];
}): Promise<number> {
  const serviceId = asNumber(args.serviceId);
  const paths: string[] = [];
  for (const raw of args.paths) {
    const p = normalizeDrivePath(raw);
    if (p && !paths.includes(p)) paths.push(p);
  }
  if (!serviceId || !paths.length) {
    throw Object.assign(new Error("No hay fotos para enviar a impresión"), {
      status: 400,
    });
  }

  return transaccion(async (conn) => {
    await conn.query(
      `UPDATE print_requests SET active = 0, status = 'reopened'
        WHERE id_purchased_package_service = ? AND active = 1`,
      [serviceId]
    );
    const [res]: any = await conn.query(
      `INSERT INTO print_requests
         (id_purchased_package_service, id_user, status, sent_at, active)
       VALUES (?, ?, 'sent', NOW(), 1)`,
      [serviceId, args.userId || null]
    );
    const requestId = Number(res.insertId);
    for (const p of paths) {
      await conn.query(
        `INSERT INTO print_requests_items (id_print_request, path)
         VALUES (?, ?)`,
        [requestId, p]
      );
    }
    return requestId;
  });
}

/**
 * Todos los envíos activos, listos para el módulo: servicio, paquete,
 * cliente, formato y fotos.
 */
export async function printRequests(): Promise<PrintRequest[]> {
  let rows: any[] = [];
  try {
    rows = await q<any>(
      `SELECT r.id, r.id_purchased_package_service AS serviceId,
              r.id_user AS clientId, r.status, r.id_format AS formatId,
              r.border, r.sent_at AS sentAt, r.finished_at AS finishedAt,
              CONCAT_WS(' ', u.name, u.lastname) AS clientName,
              pp.name AS packageName,
              COALESCE(s.name, 'Servicio') AS serviceName,
              f.name AS formatName
         FROM print_requests r
         JOIN purchased_packages_services pps
           ON pps.id = r.id_purchased_package_service
         JOIN purchased_packages pp
           ON pp.id = pps.id_purchased_package
         LEFT JOIN services s ON s.id = pps.id_service
         LEFT JOIN users u ON u.id = r.id_user
         LEFT JOIN print_formats f ON f.id = r.id_format
        WHERE r.active = 1
        ORDER BY r.sent_at DESC, r.id DESC`
    );
  } catch {
    return []; // migración pendiente
  }
  if (!rows.length) return [];

  const ids = rows.map((r) => asNumber(r.id));
  // Las posiciones van en su propia consulta: si la migración todavía no se
  // aplicó, el listado sigue funcionando (solo se pierde el encuadre).
  const cropsByRequest = new Map<number, Record<string, PrintCropEntry>>();
  try {
    const saved = await q<{ id: number; crops: string | null }>(
      `SELECT id, crops FROM print_requests WHERE id IN (?)`,
      [ids]
    );
    for (const row of saved) {
      const crops = parsePrintCrops(row.crops);
      if (Object.keys(crops).length) {
        cropsByRequest.set(asNumber(row.id), crops);
      }
    }
  } catch {
    // Columna pendiente de migración: sin posiciones guardadas.
  }
  const items = new Map<number, string[]>();
  try {
    const photos = await q<any>(
      `SELECT id_print_request AS requestId, path
         FROM print_requests_items
        WHERE active = 1 AND id_print_request IN (?)
        ORDER BY id ASC`,
      [ids]
    );
    for (const p of photos) {
      const key = asNumber(p.requestId);
      const path = normalizeDrivePath(p.path);
      if (!path) continue;
      const list = items.get(key) ?? [];
      if (!list.includes(path)) list.push(path);
      items.set(key, list);
    }
  } catch {
    // Sin fotos: el envío se muestra vacío en vez de romper el listado.
  }

  return rows.map((r) => ({
    id: asNumber(r.id),
    serviceId: asNumber(r.serviceId),
    clientId: r.clientId === null ? null : asNumber(r.clientId),
    clientName: norm(r.clientName) || "Sin cliente",
    packageName: norm(r.packageName),
    serviceName: norm(r.serviceName),
    status: norm(r.status) === "finished" ? "finished" : "sent",
    formatId: r.formatId === null ? null : asNumber(r.formatId),
    formatName: norm(r.formatName),
    border: asNumber(r.border),
    sentAt: norm(r.sentAt),
    finishedAt: norm(r.finishedAt),
    photos: items.get(asNumber(r.id)) ?? [],
    crops: cropsByRequest.get(asNumber(r.id)) ?? {},
  }));
}

/**
 * Guarda el formato, el borde y las POSICIONES de las fotos SIN cerrar el
 * envío: el estudio puede ajustar hoy, descargar, y seguir mañana donde lo
 * dejó. El cliente sigue bloqueado (status = sent) hasta dar «Terminar».
 */
export async function savePrintRequestConfig(args: {
  id: number;
  formatId: number;
  border: number;
  crops: unknown;
}): Promise<{ id: number; border: number; crops: number }> {
  const id = asNumber(args.id);
  const formatId = asNumber(args.formatId);
  if (!id) {
    throw Object.assign(new Error("Indica el envío"), { status: 400 });
  }
  if (!formatId) {
    throw Object.assign(new Error("Elige el formato de impresión"), {
      status: 400,
    });
  }
  const current = await q<{ status: string }>(
    `SELECT status FROM print_requests WHERE id = ? AND active = 1 LIMIT 1`,
    [id]
  );
  if (!current.length) {
    throw Object.assign(new Error("Ese envío ya no existe"), { status: 404 });
  }
  if (norm(current[0].status) === "finished") {
    throw Object.assign(
      new Error("El trabajo está terminado: reábrelo para cambiar el formato"),
      { status: 409 }
    );
  }
  const border = Math.max(0, Math.min(30, Math.round(asNumber(args.border))));
  const crops = sanitizePrintCrops(args.crops);
  const payload = JSON.stringify(crops);
  try {
    await exec(
      `UPDATE print_requests SET id_format = ?, border = ?, crops = ?
        WHERE id = ?`,
      [formatId, border, payload, id]
    );
  } catch (e) {
    if (!missingColumn(e)) throw e;
    // Sin la migración de posiciones: se avisa en vez de guardar a medias.
    throw Object.assign(
      new Error(
        "El servidor no tiene aplicada la migración de posiciones de impresión"
      ),
      { status: 500, cause: e }
    );
  }
  return { id, border, crops: Object.keys(crops).length };
}

/** Cierra un envío con su formato, grosor de borde y posiciones. */
export async function finishPrintRequest(args: {
  id: number;
  formatId: number;
  border: number;
  crops?: unknown;
}): Promise<void> {
  const border = Math.max(0, Math.min(30, Math.round(asNumber(args.border))));
  const withCrops = args.crops !== undefined;
  const payload = JSON.stringify(sanitizePrintCrops(args.crops));
  let r;
  try {
    r = await exec(
      `UPDATE print_requests
          SET status = 'finished', id_format = ?, border = ?,
              finished_at = NOW(), active = 1${withCrops ? ", crops = ?" : ""}
        WHERE id = ?`,
      withCrops
        ? [args.formatId || null, border, payload, args.id]
        : [args.formatId || null, border, args.id]
    );
  } catch (e) {
    // Cerrar el trabajo NUNCA debe quedar bloqueado por la migración de
    // posiciones: se termina sin ellas (el encuadre ya se pudo guardar antes).
    if (!withCrops || !missingColumn(e)) throw e;
    r = await exec(
      `UPDATE print_requests
          SET status = 'finished', id_format = ?, border = ?,
              finished_at = NOW(), active = 1
        WHERE id = ?`,
      [args.formatId || null, border, args.id]
    );
  }
  if (!r.affectedRows) {
    throw Object.assign(new Error("Ese envío ya no existe"), { status: 404 });
  }
}

/**
 * Reabre un envío: deja de estar activo y el cliente vuelve a poder cambiar
 * su selección. El historial se conserva (active = 0).
 */
export async function reopenPrintRequest(id: number): Promise<number> {
  const row = await q<{ serviceId: number }>(
    `SELECT id_purchased_package_service AS serviceId
       FROM print_requests WHERE id = ? LIMIT 1`,
    [id]
  );
  await exec(
    `UPDATE print_requests
        SET status = 'reopened', active = 0, finished_at = NULL
      WHERE id = ?`,
    [id]
  );
  return asNumber(row[0]?.serviceId);
}

/** ¿El servicio pertenece a un paquete ACTIVO del usuario? */
export async function userOwnsService(
  userId: number,
  serviceId: number,
  isAdmin: boolean
): Promise<boolean> {
  if (isAdmin) return true;
  const rows = await q<{ id: number }>(
    `SELECT pps.id
       FROM purchased_packages_services pps
       JOIN users_packages up
         ON up.id_purchased_package = pps.id_purchased_package AND up.active = 1
      WHERE pps.id = ? AND pps.active = 1 AND up.id_user = ?`,
    [serviceId, userId]
  );
  return rows.length > 0;
}

/**
 * Fotos guardadas en el servicio (la selección del cliente). Se copian al
 * envío, así un cambio posterior de la selección no altera lo enviado.
 */
export async function serviceSelection(serviceId: number): Promise<string[]> {
  const rows = await q<{ path: string }>(
    `SELECT path FROM purchased_packages_services_items
      WHERE active = 1 AND id_purchased_package_service = ?
      ORDER BY id ASC`,
    [serviceId]
  );
  return rows
    .map((r) => normalizeDrivePath(r.path))
    .filter((p, i, all) => p !== "" && all.indexOf(p) === i);
}
