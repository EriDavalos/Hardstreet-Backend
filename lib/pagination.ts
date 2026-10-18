// ==================================================================
// HARD STREET BACKEND - Paginación de los listados
// ==================================================================
// Todos los GET de listado aceptan los MISMOS dos parámetros:
//
//   ?page=1&limit=30
//
// `page` empieza en 1 y `limit` son las filas por página (de fábrica 30; la
// app ofrece 30, 50, 100 y 200). La respuesta lleva SIEMPRE:
//
//   { ..., total, limit, page, pages }
//
// `total` es el número de filas SIN paginar (para que la app sepa si hay
// siguiente página) y `pages` las páginas que salen con ese `limit`.
//
// Si un cliente viejo no manda nada, recibe la primera página de 30: la app
// nunca ve "todo de golpe" y el servidor no se pone a mandar tablas enteras.
// ==================================================================
import type { NextApiRequest } from "next";

/** Tamaños de página que ofrece la app (el backend acepta 1..200). */
export const PAGE_SIZES = [30, 50, 100, 200] as const;

/** Filas por página de fábrica. */
export const DEFAULT_LIMIT = 30;

/** Tope duro: nadie pide 5000 filas por la URL. */
export const MAX_LIMIT = 200;

export type Paging = { limit: number; page: number; offset: number };

const int = (v: unknown): number | null => {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/**
 * Lee `limit` y `page` de la URL. Tolera `offset` (los clientes viejos que
 * paginaban así) para no romper la bitácora ni el drive.
 */
export function readPaging(req: NextApiRequest): Paging {
  // `all=1`: la app lo usa para los desplegables y los totales del Dashboard,
  // que necesitan la lista completa (no una página). No es un listado.
  if (String(req.query.all) === "1") {
    return { limit: 100000, page: 1, offset: 0 };
  }

  const rawLimit = int(req.query.limit);
  const limit = Math.min(
    Math.max(rawLimit === null ? DEFAULT_LIMIT : rawLimit, 1),
    MAX_LIMIT
  );

  const rawPage = int(req.query.page);
  if (rawPage !== null) {
    const page = Math.max(rawPage, 1);
    return { limit, page, offset: (page - 1) * limit };
  }

  // Compatibilidad: `offset` = cuántas filas saltar. Se traduce a página.
  const rawOffset = int(req.query.offset);
  const offset = Math.max(rawOffset ?? 0, 0);
  const page = Math.floor(offset / limit) + 1;
  return { limit, page, offset: (page - 1) * limit };
}

/** Metadatos de paginación que acompañan al listado. */
export function pageMeta(total: unknown, p: Paging) {
  const n = Math.max(0, Number(total) || 0);
  const pages = Math.max(1, Math.ceil(n / p.limit));
  return {
    total: n,
    limit: p.limit,
    page: Math.min(Math.max(p.page, 1), pages),
    pages,
  };
}
