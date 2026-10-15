import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requireUser } from "../../../lib/auth";
import { q } from "../../../lib/db";
import { userIsAdmin, userRoleId } from "../../../lib/permissions";
import {
  normalizeDrivePath,
  packageDrivePathsByIds,
  userDrivePaths,
} from "../../../lib/drive-paths";
import { sharesByTarget } from "../../../lib/user-shares";

// ==================================================================
// Carpetas COMPARTIDAS con el usuario logueado  ->  /api/my/drive
//
//   GET  {
//     isClient,   // true = su drive se limita a lo compartido
//     role,       // nombre del rol (para diagnóstico)
//     paths: [ { packageId, packageName, path } ]
//   }
//
// `paths` sale de las carpetas compartidas de los paquetes ACTIVOS del
// usuario (tabla `purchased_packages_drive`, con la columna vieja
// `purchased_packages.drive_path` como respaldo): un paquete puede compartir
// VARIAS carpetas, así que aquí sale una entrada por carpeta. El drive del
// cliente muestra SOLO esas carpetas; sin ellas no ve nada (aún no se le
// comparte nada).
//
// El rol ADMIN nunca se limita: ve el drive completo. Si las migraciones
// todavía no se aplicaron, la consulta cae a un modo sin carpetas en vez de
// fallar.
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
        `SELECT pp.id AS package_id, pp.name
           FROM users_packages up
           JOIN purchased_packages pp
             ON pp.id = up.id_purchased_package AND pp.active = 1
          WHERE up.id_user = ? AND up.active = 1
          ORDER BY up.id DESC`,
        [session.sub]
      );
    } catch {
      rows = [];
    }

    // Las carpetas de cada paquete (tabla nueva + respaldo de la columna vieja).
    const folders = await packageDrivePathsByIds(
      rows.map((r) => Number(r.package_id || 0))
    );

    const paths = rows.flatMap((r) => {
      const packageId = Number(r.package_id || 0);
      const packageName = String(r.name || "");
      return (folders.get(packageId) ?? [])
        .map((p) => normalizeDrivePath(p))
        .filter((p) => p !== "")
        .map((path) => ({ packageId, packageName, path }));
    });

    // Carpetas compartidas DIRECTAMENTE con el usuario (no con un paquete en
    // particular): las ve en todos sus paquetes. Van marcadas con
    // packageId = 0 para que el cliente sepa que no son de un paquete.
    for (const path of await userDrivePaths(Number(session.sub))) {
      const clean = normalizeDrivePath(path);
      if (clean === "") continue;
      if (paths.some((p) => p.path === clean)) continue;
      paths.push({ packageId: 0, packageName: "Compartido contigo", path: clean });
    }

    // Carpetas que OTROS USUARIOS me compartieron desde "Archivos
    // compartidos" (user_drive_shares): también se ven en mi Drive, junto a
    // las de mis paquetes. El nombre del que comparte es el de la carpeta.
    for (const folder of await sharesByTarget(Number(session.sub))) {
      const clean = normalizeDrivePath(folder.path);
      if (clean === "") continue;
      if (paths.some((p) => p.path === clean)) continue;
      const who = folder.owners.map((o) => o.name).filter(Boolean).join(", ");
      paths.push({
        packageId: 0,
        packageName: who ? `Compartido por ${who}` : "Compartido contigo",
        path: clean,
      });
    }

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
