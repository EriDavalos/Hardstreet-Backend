import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requireAdmin } from "../../../lib/admin-auth";
import { q, exec, transaccion } from "../../../lib/db";
import { ADMIN_MODULES, ACTION_LABELS } from "../../../lib/admin-modules";

// ==================================================================
// Metadatos del panel (solo rol Admin)  ->  /api/admin/meta
//   GET  árbol de grupos/módulos/acciones para el modal de permisos.
//   Sincroniza los módulos admin en la tabla `modules` (upsert por url)
//   y resuelve los IDs reales de `modules` y `permissions`.
// ==================================================================

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (!(await requireAdmin(req, res))) return;

  try {
    if (req.method !== "GET") {
      res.status(405).json({ error: "Metodo no permitido" });
      return;
    }

    // 1. Upsert de módulos admin (por url, case-insensitive)
    for (const group of ADMIN_MODULES) {
      for (const mod of group.modules) {
        const existing = await q<{ id: number }>(
          `SELECT id FROM modules WHERE LOWER(url) = ? LIMIT 1`,
          [mod.url.toLowerCase()]
        );
        if (!existing.length) {
          const maxOrder = await q<{ mx: number | null }>(
            `SELECT MAX(\`order\`) AS mx FROM modules`
          );
          const nextOrder = Number(maxOrder[0]?.mx || 0) + 1;
          await exec(`INSERT INTO modules (name, url, \`order\`) VALUES (?, ?, ?)`, [
            mod.name,
            mod.url,
            nextOrder,
          ]);
        }
      }
    }

    // 2. Arbol con IDs resueltos
    const permissions = await q<{ id: number; key: string | null }>(
      `SELECT id, \`key\` FROM permissions WHERE active = 1 ORDER BY id ASC`
    );
    const permByKey = new Map(
      permissions.map((p) => [String(p.key || "").toLowerCase(), Number(p.id)])
    );

    const dbModules = await q<{ id: number; name: string | null; url: string | null }>(
      `SELECT id, name, url FROM modules WHERE active = 1`
    );

    const tree = ADMIN_MODULES.map((group) => ({
      id: group.id,
      name: group.name,
      modules: group.modules
        .map((mod) => {
          const dbm = dbModules.find(
            (m) => String(m.url || "").toLowerCase() === mod.url.toLowerCase()
          );
          return {
            id: dbm?.id ?? null,
            name: mod.name,
            url: mod.url,
            actions: mod.actions
              .map((a) => {
                const pid = permByKey.get(a.toLowerCase());
                return pid
                  ? { id: pid, key: a, label: ACTION_LABELS[a] || a }
                  : null;
              })
              .filter(Boolean),
          };
        })
        .filter((m) => m.id !== null),
    })).filter((g) => g.modules.length > 0);

    res.status(200).json({
      tree,
      permissions: permissions.map((p) => ({
        id: p.id,
        key: p.key,
        label: ACTION_LABELS[String(p.key || "").toLowerCase()] || p.key,
      })),
    });
  } catch (e) {
    console.error("[admin/meta]", e);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});
