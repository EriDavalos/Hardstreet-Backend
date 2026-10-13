import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requireUser } from "../../../lib/auth";
import { q } from "../../../lib/db";
import { userIsAdmin, userRoleId } from "../../../lib/permissions";

// ==================================================================
// Carpetas COMPARTIDAS con el usuario logueado  ->  /api/my/drive
//
//   GET  {
//     isClient,   // true = su drive se limita a lo compartido
//     role,       // nombre del rol (para diagnóstico)
//     paths: [ { packageId, packageName, path } ]
//   }
//
// `paths` sale de `purchased_packages.drive_path` de los paquetes ACTIVOS
// del usuario (la carpeta que el estudio le compartió desde el
// administrador del paquete). El drive del cliente muestra SOLO esas
// carpetas; sin ellas no ve nada (aún no se le comparte nada).
//
// El rol ADMIN nunca se limita: ve el drive completo. Si la migración
// `2026-10-15_movimientos_generales_y_carpeta_compartida.sql` todavía no
// se aplicó, la consulta cae a un modo sin carpetas en vez de fallar.
// ==================================================================

type Row = Record<string, any>;

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Metodo no permitido" });
    return;
  }

  const session = await requireUser(req, res);
  if (!session) return;

  try {
    const roleId = await userRoleId(session.sub);
    const isAdmin = await userIsAdmin(roleId);

    let rows: Row[];
    try {
      rows = await q<Row>(
        `SELECT pp.id AS package_id, pp.name, pp.drive_path
           FROM users_packages up
           JOIN purchased_packages pp
             ON pp.id = up.id_purchased_package AND pp.active = 1
          WHERE up.id_user = ? AND up.active = 1
          ORDER BY up.id DESC`,
        [session.sub]
      );
    } catch {
      // Columna `drive_path` pendiente de migración: sin carpetas.
      rows = await q<Row>(
        `SELECT pp.id AS package_id, pp.name
           FROM users_packages up
           JOIN purchased_packages pp
             ON pp.id = up.id_purchased_package AND pp.active = 1
          WHERE up.id_user = ? AND up.active = 1
          ORDER BY up.id DESC`,
        [session.sub]
      );
    }

    const paths = rows
      .map((r) => ({
        packageId: Number(r.package_id || 0),
        packageName: String(r.name || ""),
        path: String(r.drive_path || "").trim(),
      }))
      .filter((p) => p.path !== "");

    const role = String(session.role || "");
    res.status(200).json({
      // Solo el CLIENTE se limita (nunca el Admin). Un usuario con paquetes
      // comprados es cliente aunque su rol se llame de otra forma.
      isClient: !isAdmin && (role.toLowerCase() === "cliente" || rows.length > 0),
      role,
      packages: rows.length,
      paths,
    });
  } catch (e) {
    console.error("[my/drive]", e);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});
