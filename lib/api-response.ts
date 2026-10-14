// ==================================================================
// HARD STREET BACKEND - Envoltura ÚNICA de respuestas de la API
// ==================================================================
// Todas las respuestas comparten la MISMA forma:
//
//   Éxito   { code: 200|201, ok: true,  message: "...", item: {...} }
//   Error   { code: 4xx|5xx, ok: false, message: "...", details: "..." }
//
// `message` es el texto humano que la app muestra en la notificación
// lateral (verde al éxito, rojo al error) y `item` el modelo afectado
// (creado, actualizado o eliminado) para que el cliente no tenga que
// volver a pedirlo.
//
// Se conservan las claves antiguas (`ok`, `error`) para no romper a los
// clientes que todavía lean `error`.
// ==================================================================
import type { NextApiResponse } from "next";

export type Extra = Record<string, unknown>;

/**
 * Respuesta de ÉXITO.
 * [extra] se mezcla en el cuerpo: úsalo para el modelo afectado
 * (`item`) y para los campos que el cliente ya consumía (paid, id...).
 */
export function ok(
  res: NextApiResponse,
  message: string,
  extra: Extra = {},
  status = 200
): void {
  res.status(status).json({
    code: status,
    ok: true,
    message,
    // `item` SIEMPRE presente (null si la operación no devuelve modelo).
    item: extra.item ?? null,
    ...extra,
  });
}

/** ÉXITO de creación (201). */
export function created(
  res: NextApiResponse,
  message: string,
  extra: Extra = {}
): void {
  ok(res, message, extra, 201);
}

/**
 * Respuesta de ERROR: `message` es lo que verá el usuario y [details] el
 * motivo concreto (permiso que falta, campo inválido, etc.).
 */
export function fail(
  res: NextApiResponse,
  status: number,
  message: string,
  details?: unknown
): void {
  res.status(status).json({
    code: status,
    ok: false,
    // Compatibilidad: los clientes viejos leían `error`.
    error: message,
    message,
    details: details ?? null,
  });
}
