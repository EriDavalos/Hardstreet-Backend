import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { q, exec } from "../../../lib/db";
import { ok, created, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";
import { readPaging, pageMeta } from "../../../lib/pagination";

// ==================================================================
// Catálogo de CATEGORÍAS de paquetes (módulo "Categorías")
//   -> /api/admin/categories
//   GET            lista las categorías activas (id, name, icon, urlImage)
//   POST           crea categoría { name, icon?, urlImage? }
//   PUT/PATCH      actualiza { id, ...campos }
//   DELETE         baja lógica (?id=N) — active = 0
//
// Las categorías agrupan los paquetes del catálogo y son las que la web usa
// para filtrarlos (`packages_categories`). El panel las lee por
// /api/categories (público, solo lectura); aquí es donde se administran.
//
// PERMISOS: módulo "Categorías" con ver/crear/editar/eliminar (migración
// 2026-10-16_categorias_permisos.sql). Antes se pedía el permiso de Paquetes.
//
// BORRAR una categoría NO deja paquetes huérfanos: los suyos pasan a
// "General" (se crea si no existe). Esa es la categoría de destino y por eso
// no se puede eliminar.
//
// El `icon` es opcional y hoy está RESERVADO: el panel y la web dibujan el
// icono de una categoría a partir de su NOMBRE (Boda 💍, XV Años 👑…), así que
// una categoría creada solo con el nombre ya se ve bien en los dos lados.
// ==================================================================

const norm = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/// Categoría que recibe los paquetes de una categoría eliminada.
const GENERAL_CATEGORY = "General";

/** Id de "General", creándola si aún no existe (idempotente). */
async function ensureGeneralCategory(): Promise<number> {
  const found = await q<{ id: number }>(
    `SELECT id FROM packages_categories
      WHERE active = 1 AND LOWER(name) = LOWER(?)
      LIMIT 1`,
    [GENERAL_CATEGORY]
  );
  if (found.length) return Number(found[0].id);
  const r = await exec(
    `INSERT INTO packages_categories (name) VALUES (?)`,
    [GENERAL_CATEGORY]
  );
  return Number(r.insertId);
}

type Row = {
  id: number;
  name: string | null;
  icon: string | null;
  url_image?: string | null;
};

function map(r: Row) {
  return {
    id: Number(r.id),
    name: r.name || "",
    icon: r.icon || "",
    // Foto que representa la categoría en la galería del panel (puede venir
    // del Drive o de un enlace). Vacía = todavía no tiene.
    urlImage: r.url_image || "",
  };
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  // Permiso por acción sobre el módulo "Paquetes" (Admin pasa siempre).
  const ACTIONS: Record<string, "read" | "create" | "update" | "delete"> = {
    GET: "read",
    POST: "create",
    PUT: "update",
    PATCH: "update",
    DELETE: "delete",
  };
  const action = ACTIONS[req.method || ""];
  if (!action) {
    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
    return;
  }
  const me = await requirePermission(req, res, "Categorías", action);
  if (!me) return;

  try {
    if (req.method === "GET") {
      // Paginado: ?page=1&limit=30 (igual que los demás módulos).
      const p = readPaging(req);
      const countRows = await q<{ n: number }>(
        `SELECT COUNT(*) AS n FROM packages_categories WHERE active = 1`
      );
      // La foto es opcional: si la migración de la columna todavía no se
      // aplicó, se listan las categorías igual (sin foto).
      let rows: Row[];
      try {
        rows = await q<Row>(
          `SELECT id, name, icon, url_image
             FROM packages_categories
            WHERE active = 1
            ORDER BY id ASC
            LIMIT ${p.limit} OFFSET ${p.offset}`
        );
      } catch {
        rows = await q<Row>(
          `SELECT id, name, icon
             FROM packages_categories
            WHERE active = 1
            ORDER BY id ASC
            LIMIT ${p.limit} OFFSET ${p.offset}`
        );
      }
      res.status(200).json({
        categories: rows.map(map),
        ...pageMeta(countRows[0]?.n, p),
      });
      return;
    }

    if (req.method === "DELETE") {
      const id = Number(req.query.id || 0);
      if (!id) {
        fail(
          res,
          400,
          "Falta la categoría",
          "Indica qué categoría quieres eliminar"
        );
        return;
      }
      const row = await q<{ id: number; name: string | null }>(
        `SELECT id, name FROM packages_categories WHERE id = ? AND active = 1 LIMIT 1`,
        [id]
      );
      if (!row.length) {
        fail(
          res,
          404,
          "Categoría no encontrada",
          `No hay una categoría activa con id ${id}`
        );
        return;
      }
      // "General" es el destino de los paquetes cuando se borra su categoría:
      // borrarla dejaría a los demás sin dónde caer.
      if (GENERAL_CATEGORY.toLowerCase() === String(row[0].name || "").trim().toLowerCase()) {
        fail(
          res,
          409,
          "Esa categoría no se puede eliminar",
          `"${GENERAL_CATEGORY}" es donde caen los paquetes cuando se elimina su categoría`
        );
        return;
      }
      // Los paquetes de la categoría NO se quedan sin categoría: pasan a
      // "General" (que se crea si todavía no existe).
      const generalId = await ensureGeneralCategory();
      const moved = await exec(
        `UPDATE packages
            SET id_package_category = ?
          WHERE id_package_category = ? AND active = 1`,
        [generalId, id]
      );
      const r = await exec(
        `UPDATE packages_categories SET active = 0 WHERE id = ?`,
        [id]
      );
      if (!r.affectedRows) {
        fail(
          res,
          404,
          "Categoría no encontrada",
          `No hay una categoría activa con id ${id}`
        );
        return;
      }
      const movedCount = Number(moved.affectedRows || 0);
      await logActivity({
        userId: me.sub,
        module: "categories",
        moduleName: "Categorías",
        action: "delete",
        entity: "categoría",
        entityId: id,
        description: "Categoría eliminada exitosamente",
        details: { id, name: row[0].name || "", movedToGeneral: movedCount },
        req,
      });
      ok(res, "Categoría eliminada exitosamente", {
        item: { id, movedToGeneral: movedCount, generalId },
      });
      return;
    }

    const b = (req.body || {}) as Record<string, unknown>;
    const name = norm(b.name);
    const icon = norm(b.icon);
    // Acepta las dos formas (`urlImage` es como la manda el panel).
    const urlImage = norm(b.urlImage) || norm(b.url_image);

    if (req.method === "POST") {
      if (!name) {
        fail(res, 400, "Escribe el nombre de la categoría", "El nombre no puede ir vacío");
        return;
      }
      // Repetida (activa): se dice, en vez de crear una gemela que después
      // parte los paquetes entre las dos.
      const dup = await q<{ id: number }>(
        `SELECT id FROM packages_categories
          WHERE active = 1 AND LOWER(name) = LOWER(?)
          LIMIT 1`,
        [name]
      );
      if (dup.length) {
        fail(
          res,
          409,
          "Esa categoría ya existe",
          `Ya hay una categoría llamada "${name}"`
        );
        return;
      }
      const r = await exec(
        `INSERT INTO packages_categories (name, icon, url_image) VALUES (?, ?, ?)`,
        [name, icon || null, urlImage || null]
      );
      const item = { id: Number(r.insertId), name, icon, urlImage };
      await logActivity({
        userId: me.sub,
        module: "packages",
        moduleName: "Paquetes",
        action: "create",
        entity: "categoría",
        entityId: Number(r.insertId),
        description: "Categoría creada exitosamente",
        details: item,
        req,
      });
      created(res, "Categoría creada exitosamente", { item });
      return;
    }

    // ---- PUT / PATCH: actualiza solo los campos enviados ----
    const id = Number(b.id || 0);
    if (!id) {
      fail(
        res,
        400,
        "Falta la categoría",
        "Indica qué categoría quieres modificar"
      );
      return;
    }
    const fields: string[] = [];
    const params: unknown[] = [];
    if (b.name !== undefined) {
      if (!name) {
        fail(res, 400, "El nombre no puede ir vacío", "Escribe el nombre de la categoría");
        return;
      }
      fields.push("`name` = ?");
      params.push(name);
    }
    if (b.icon !== undefined) {
      fields.push("`icon` = ?");
      params.push(icon || null);
    }
    if (b.urlImage !== undefined || b.url_image !== undefined) {
      fields.push("`url_image` = ?");
      params.push(urlImage || null);
    }
    if (!fields.length) {
      fail(res, 400, "Nada que actualizar", "No enviaste ningún campo de la categoría");
      return;
    }
    const r = await exec(
      `UPDATE packages_categories SET ${fields.join(", ")} WHERE id = ?`,
      [...params, id]
    );
    if (!r.affectedRows) {
      fail(
        res,
        404,
        "Categoría no encontrada",
        `No hay una categoría activa con id ${id}`
      );
      return;
    }
    const item = { id, name, icon, urlImage };
    await logActivity({
      userId: me.sub,
      module: "packages",
      moduleName: "Paquetes",
      action: "update",
      entity: "categoría",
      entityId: id,
      description: "Categoría actualizada exitosamente",
      details: item,
      req,
    });
    ok(res, "Categoría actualizada exitosamente", { item });
    return;
  } catch (e) {
    console.error("[admin/categories]", e);
    fail(res, 500, "Hubo un error", "No se pudo completar la operación de la categoría");
  }
});
