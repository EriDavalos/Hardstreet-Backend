import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requireUser } from "../../../lib/auth";
import { q } from "../../../lib/db";
import { userRoleId, userIsAdmin } from "../../../lib/permissions";
import { fail } from "../../../lib/api-response";

// ==================================================================
// Permisos del usuario autenticado  ->  /api/admin/permission
//   GET  {
//     isAdmin,
//     modules: [{ key: "drive", name: "Archivos", actions: ["read",...] }]
//   }
//
// `key`  = columna modules.module (la CLAVE: home, drive, users, rols...)
// `name` = columna modules.name    (el nombre visible: Inicio, Archivos...)
// El panel registra AMBAS para identificar el módulo sin importar cuál use.
//
// Devuelve TODOS los módulos activos (aunque el rol no tenga ningún permiso
// sobre ellos), con las acciones que SÍ tiene. Así el panel sabe que un módulo
// existe y puede OCULTARLO cuando falta "Ver" (read): si solo se devolvieran
// los módulos con permisos, los demás quedarían "desconocidos" y no se
// ocultarían. El backend en sí sigue autorizando cada acción por separado.
// ==================================================================

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
    return;
  }

  const session = await requireUser(req, res);
  if (!session) return;

  try {
    const roleId = await userRoleId(session.sub);
    if (!roleId) {
      fail(res, 401, "Sesión inválida", "Tu usuario ya no existe o está inactivo");
      return;
    }

    const rows = await q<{
      module: string | null;
      name: string | null;
      description: string | null;
      pkey: string | null;
      morder: number | null;
      ckey: string | null;
      cname: string | null;
      corder: number | null;
    }>(
      // OJO: `key` es palabra reservada de MySQL -> el alias DEBE ser otro
      // (pkey) o el driver muere con "Error interno del servidor"
      // Se incluye la CATEGORÍA (o null si el módulo va suelto) y el orden
      // del módulo y de su categoría: el sidebar los usa para agrupar.
      // LEFT JOIN hacia el rol: los módulos SIN permiso salen con pkey NULL.
      `SELECT m.\`module\` AS module, m.name, m.description,
              m.\`order\` AS morder,
              mc.\`key\` AS ckey, mc.description AS cname, mc.\`order\` AS corder,
              p.\`key\` AS pkey
         FROM modules m
         LEFT JOIN module_categories mc
                ON mc.id = m.id_module_category AND mc.active = 1
         LEFT JOIN permissions_roles pr
                ON pr.id_modules = m.id AND pr.active = 1 AND pr.id_role = ?
         LEFT JOIN permissions p
                ON p.id = pr.id_permission AND p.active = 1
        WHERE m.active = 1`,
      [roleId]
    );

    // Agrupa por CLAVE (modules.module) en minúsculas para que la misma
    // dupla con varias filas no duplique módulos: { clave: { name, acciones } }
    const byModule = new Map<
      string,
      {
        name: string;
        description: string;
        order: number | null;
        categoryKey: string | null;
        categoryName: string | null;
        categoryOrder: number | null;
        actions: Set<string>;
      }
    >();
    for (const r of rows) {
      const clave = String(r.module || "").toLowerCase().trim();
      const name = String(r.name || "").trim();
      const action = String(r.pkey || "").toLowerCase().trim();
      // El módulo existe aunque no tenga permisos: se registra igualmente.
      if (!clave || !name) continue;
      if (!byModule.has(clave)) {
        byModule.set(clave, {
          name,
          description: String(r.description || "").trim(),
          order: r.morder,
          categoryKey: r.ckey ? String(r.ckey).trim() : null,
          categoryName: r.cname ? String(r.cname).trim() : null,
          categoryOrder: r.corder,
          actions: new Set(),
        });
      }
      if (action) byModule.get(clave)!.actions.add(action);
    }

    const modules = [...byModule.entries()]
      .map(([clave, v]) => ({
        key: clave,
        name: v.name,
        description: v.description,
        order: v.order,
        categoryKey: v.categoryKey,
        categoryName: v.categoryName,
        categoryOrder: v.categoryOrder,
        actions: [...v.actions],
      }))
      // Orden: sueltos primero, luego por categoría y dentro por módulo.
      .sort((a, b) => {
        const ca = a.categoryOrder ?? 0;
        const cb = b.categoryOrder ?? 0;
        if (ca !== cb) return ca - cb;
        return (a.order ?? 0) - (b.order ?? 0);
      });

    const isAdmin = await userIsAdmin(roleId);
    res.status(200).json({ isAdmin, modules });
  } catch (e) {
    console.error("[admin/permission]", e);
    fail(res, 500, "Hubo un error", "No se pudieron cargar tus permisos");
  }
});
