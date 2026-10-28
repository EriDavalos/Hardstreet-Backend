import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requirePermission } from "../../../lib/permissions";
import { ok, created, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";
import { q, exec } from "../../../lib/db";
import {
  driveTable,
  duplicateShareReason,
  normalizeDrivePath,
  sameDrivePath,
  userDrivePaths,
} from "../../../lib/drive-paths";

// ==================================================================
// CARPETAS DEL DRIVE COMPARTIDAS CON UN USUARIO -> /api/admin/user-drive
//
//   GET     ?userId=N
//           { userId, userName, paths: ["XV/ReynaCoot", ...] }
//
//   POST    { userId, path }
//           Comparte UNA carpeta del Drive con el usuario. A diferencia del
//           paquete (que comparte una sola), el usuario SÍ puede tener
//           VARIAS: es su Drive personal y las ve en todos sus paquetes.
//
//   DELETE  ?userId=N&path=<ruta>
//           Deja de compartir esa carpeta con el usuario.
//
// Las carpetas viven en `users_drive` con `id_user` (la misma tabla que lee
// /api/my/drive), así que el Drive del cliente no cambia de fuente: solo se
// administran desde el módulo Usuarios.
// Permiso: módulo "users" (ver para GET, editar para el resto).
// ==================================================================

function cleanPath(raw: unknown): string {
  return normalizeDrivePath(raw);
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  if (!["GET", "POST", "DELETE"].includes(req.method || "")) {
    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
    return;
  }
  const action = req.method === "GET" ? "read" : "update";
  const me = await requirePermission(req, res, "users", action);
  if (!me) return;

  try {
    if (req.method === "GET") {
      const userId = Number(req.query.userId || 0);
      if (!userId) {
        fail(res, 400, "Falta el usuario", "Indica de qué usuario quieres las carpetas");
        return;
      }
      const rows = await q<{ name: string | null; lastname: string | null }>(
        `SELECT name, lastname FROM users WHERE id = ? AND active = 1 LIMIT 1`,
        [userId]
      );
      if (!rows.length) {
        fail(res, 404, "Usuario no encontrado", `No hay un usuario activo con id ${userId}`);
        return;
      }
      const userName =
        `${rows[0].name || ""} ${rows[0].lastname || ""}`.trim() ||
        `Usuario #${userId}`;
      res.status(200).json({
        userId,
        userName,
        paths: await userDrivePaths(userId),
      });
      return;
    }

    if (req.method === "POST") {
      const b = (req.body || {}) as Record<string, unknown>;
      const userId = Number(b.userId || 0);
      const path = cleanPath(b.path);
      if (!userId || !path) {
        fail(
          res,
          400,
          "Faltan datos",
          "Indica el usuario y la carpeta del Drive que se le comparte"
        );
        return;
      }
      const user = await q(
        `SELECT id FROM users WHERE id = ? AND active = 1 LIMIT 1`,
        [userId]
      );
      if (!user.length) {
        fail(res, 404, "Usuario no encontrado", `No hay un usuario activo con id ${userId}`);
        return;
      }
      // Solo se rechaza LA MISMA carpeta (el cliente la vería dos veces).
      // Una subcarpeta de algo ya compartido es otra carpeta y se permite.
      for (const other of await userDrivePaths(userId)) {
        if (sameDrivePath(path, other)) {
          fail(
            res,
            409,
            "Esa carpeta ya está compartida",
            `${duplicateShareReason(other)}: el cliente la vería dos veces en su Drive.`
          );
          return;
        }
      }
      try {
        await exec(
          `INSERT INTO ${await driveTable()} (id_user, path) VALUES (?, ?)`,
          [userId, path]
        );
      } catch {
        fail(
          res,
          409,
          "No se pudo compartir la carpeta",
          "Falta aplicar la migración de carpetas del cliente (id_user)"
        );
        return;
      }
      await logActivity({
        userId: me.sub,
        module: "users",
        moduleName: "Usuarios",
        action: "update",
        entity: "usuario-drive",
        entityId: userId,
        description: "Carpeta compartida con el usuario exitosamente",
        details: { userId, path },
        req,
      });
      created(res, "Carpeta compartida con el usuario exitosamente", {
        item: { userId, path },
        paths: await userDrivePaths(userId),
      });
      return;
    }

    // DELETE
    const userId = Number(req.query.userId || 0);
    const path = cleanPath(req.query.path);
    if (!userId || !path) {
      fail(res, 400, "Faltan datos", "Indica el usuario y la carpeta");
      return;
    }
    const r = await exec(
      `UPDATE ${await driveTable()}
          SET active = 0
        WHERE id_user = ? AND path = ? AND active = 1`,
      [userId, path]
    );
    if (!r.affectedRows) {
      fail(res, 404, "Carpeta no compartida", `«${path}» no está compartida con el usuario`);
      return;
    }
    await logActivity({
      userId: me.sub,
      module: "users",
      moduleName: "Usuarios",
      action: "update",
      entity: "usuario-drive",
      entityId: userId,
      description: "Se dejó de compartir la carpeta con el usuario exitosamente",
      details: { userId, path },
      req,
    });
    ok(res, "Se dejó de compartir la carpeta con el usuario exitosamente", {
      item: { userId, path },
      paths: await userDrivePaths(userId),
    });
  } catch (e) {
    console.error("[admin/user-drive]", e);
    fail(res, 500, "Hubo un error", "No se pudieron administrar las carpetas del usuario");
  }
});
