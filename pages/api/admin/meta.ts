import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requireUser } from "../../../lib/auth";
import { q } from "../../../lib/db";

// ==================================================================
// Metadatos del panel (solo rol Admin)  ->  /api/admin/meta
//   GET  módulos de la tabla `modules` + acciones de `permissions`.
//   Sin grupos ni submódulos: la BD es la única fuente de verdad.
//   Cada módulo se puede proteger con cualquiera de las 5 acciones.
// ==================================================================

const ACTION_LABELS: Record<string, string> = {
  read: "Ver",
  create: "Crear",
  update: "Editar",
  delete: "Eliminar",
  download: "Descargar",
};

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  // Cualquier usuario autenticado puede consultar el catálogo de módulos
  // (lo usan el panel y los modales de permisos). Los datos sensibles
  // (lista de usuarios, clientes, roles) sí exigen su permiso específico.
  if (!(await requireUser(req, res))) return;

  try {
    if (req.method !== "GET") {
      res.status(405).json({ error: "Metodo no permitido" });
      return;
    }

    const modules = await q<{
      id: number;
      name: string | null;
      url: string | null;
      order: number | null;
    }>(
      `SELECT id, name, url, \`order\`
         FROM modules
        WHERE active = 1
        ORDER BY \`order\` ASC, id ASC`
    );
    const permissions = await q<{ id: number; key: string | null }>(
      `SELECT id, \`key\` FROM permissions WHERE active = 1 ORDER BY id ASC`
    );

    res.status(200).json({
      modules: modules.map((m) => ({
        id: m.id,
        name: m.name,
        url: m.url,
        order: m.order,
        actions: permissions.map((p) => {
          const key = String(p.key || "").toLowerCase();
          return { id: p.id, key: p.key, label: ACTION_LABELS[key] || p.key };
        }),
      })),
      permissions: permissions.map((p) => {
        const key = String(p.key || "").toLowerCase();
        return { id: p.id, key: p.key, label: ACTION_LABELS[key] || p.key };
      }),
    });
  } catch (e) {
    console.error("[admin/meta]", e);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});
