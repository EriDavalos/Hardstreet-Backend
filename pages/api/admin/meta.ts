import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requireUser } from "../../../lib/auth";
import { q } from "../../../lib/db";
import { fail } from "../../../lib/api-response";

// ==================================================================
// Metadatos del panel  ->  /api/admin/meta
//   GET  módulos de la tabla `modules` + acciones de `permissions`.
//   Sin grupos ni submódulos: la BD es la única fuente de verdad.
//
//   Cada módulo trae:
//     - key / name / url / order
//     - categoryId / categoryKey / categoryName / categoryOrder (o null si
//       el módulo va "suelto", como Dashboard)
//     - actions: SOLO los permisos APLICABLES a ese módulo, según la tabla
//       `modules_permissions` (muchos a muchos). Así "Descargar" no se
//       ofrece en Clientes, etc.
//   Además `categories`: el catálogo de categorías ordenado (menor = arriba).
// ==================================================================

const ACTION_LABELS: Record<string, string> = {
  read: "Ver",
  create: "Crear",
  update: "Editar",
  delete: "Eliminar",
  download: "Descargar",
  admin_package: "Administrar paquete",
};

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  // Cualquier usuario autenticado puede consultar el catálogo de módulos
  // (lo usan el panel y los modales de permisos). Los datos sensibles
  // (lista de usuarios, clientes, roles) sí exigen su permiso específico.
  if (!(await requireUser(req, res))) return;

  try {
    if (req.method !== "GET") {
      fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
      return;
    }

    const modules = await q<{
      id: number;
      module: string | null;
      name: string | null;
      description: string | null;
      url: string | null;
      order: number | null;
      categoryId: number | null;
      categoryKey: string | null;
      categoryName: string | null;
      categoryOrder: number | null;
    }>(
      // Orden: módulos SUELTOS primero (COALESCE en 0), luego por categoría
      // (menor = arriba) y dentro por el `order` del módulo (menor = primero).
      `SELECT m.id, m.\`module\`, m.name, m.description, m.url, m.\`order\`,
              mc.id AS categoryId, mc.\`key\` AS categoryKey,
              mc.description AS categoryName, mc.\`order\` AS categoryOrder
         FROM modules m
         LEFT JOIN module_categories mc
                ON mc.id = m.id_module_category AND mc.active = 1
        WHERE m.active = 1
        ORDER BY COALESCE(mc.\`order\`, 0) ASC, m.\`order\` ASC, m.id ASC`
    );
    const permissions = await q<{ id: number; key: string | null }>(
      `SELECT id, \`key\` FROM permissions WHERE active = 1 ORDER BY id ASC`
    );
    // Permisos APLICABLES a cada módulo (relación muchos-a-muchos).
    const modPerms = await q<{ id_module: number; kkey: string | null }>(
      `SELECT mp.id_module, p.\`key\` AS kkey
         FROM modules_permissions mp
         JOIN permissions p ON p.id = mp.id_permission AND p.active = 1
        WHERE mp.active = 1`
    );
    const allowed = new Map<number, Set<string>>();
    for (const r of modPerms) {
      const k = String(r.kkey || "").toLowerCase().trim();
      if (!k) continue;
      if (!allowed.has(r.id_module)) allowed.set(r.id_module, new Set());
      allowed.get(r.id_module)!.add(k);
    }

    const catalog = permissions.map((p) => {
      const key = String(p.key || "").toLowerCase();
      return { id: p.id, key: p.key, label: ACTION_LABELS[key] || p.key };
    });

    const categories = modules
      .filter((m) => m.categoryId !== null)
      .reduce<
        { id: number; key: string | null; name: string | null; order: number | null }[]
      >((acc, m) => {
        if (acc.some((c) => c.id === m.categoryId)) return acc;
        acc.push({
          id: m.categoryId as number,
          key: m.categoryKey,
          name: m.categoryName,
          order: m.categoryOrder,
        });
        return acc;
      }, [])
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    res.status(200).json({
      categories,
      modules: modules.map((m) => {
        const keys = allowed.get(m.id);
        // Un módulo sin permisos mapeados no ofrece acciones (evita mezclar
        // "Descargar" donde no aplica); los módulos registrados sí los tienen.
        const actions = keys
          ? catalog.filter((a) =>
              keys.has(String(a.key || "").toLowerCase())
            )
          : [];
        return {
          id: m.id,
          key: String(m.module || "").toLowerCase().trim(),
          name: m.name,
          description: m.description || "",
          url: m.url,
          order: m.order,
          categoryId: m.categoryId,
          categoryKey: m.categoryKey,
          categoryName: m.categoryName,
          categoryOrder: m.categoryOrder,
          actions,
        };
      }),
      permissions: catalog,
    });
  } catch (e) {
    console.error("[admin/meta]", e);
    fail(res, 500, "Hubo un error", "No se pudieron cargar los metadatos del panel");
  }
});
