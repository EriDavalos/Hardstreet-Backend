import { q, exec } from "./db";

/**
 * ¿La migración `sort_order` de packages_services ya se aplicó? Se pregunta
 * UNA vez por proceso. Si la columna no existe se intenta crear; si tampoco
 * hay permiso de ALTER, todo sigue funcionando y se ordena por id como antes.
 */
let _hasSortOrderColumn: boolean | null = null;

export async function hasSortOrderColumn(): Promise<boolean> {
  if (_hasSortOrderColumn !== null) return _hasSortOrderColumn;
  try {
    const rows = await q(`SHOW COLUMNS FROM packages_services LIKE 'sort_order'`);
    _hasSortOrderColumn = rows.length > 0;
    if (!_hasSortOrderColumn) {
      try {
        await exec(
          `ALTER TABLE packages_services ADD COLUMN sort_order INT NOT NULL DEFAULT 0`
        );
        _hasSortOrderColumn = true;
      } catch {
        // Sin permiso de ALTER: se conserva el orden por id.
      }
    }
  } catch {
    _hasSortOrderColumn = false;
  }
  return _hasSortOrderColumn;
}

/** ORDER BY de los servicios de un paquete, con o sin la columna nueva. */
export function serviceOrderBy(ordered: boolean, alias = "ps"): string {
  return ordered
    ? `${alias}.sort_order ASC, ${alias}.id ASC`
    : `${alias}.id ASC`;
}
