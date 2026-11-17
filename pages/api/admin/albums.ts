import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requireAnyOfPermissions } from "../../../lib/permissions";
import { ok, created, fail } from "../../../lib/api-response";
import { logActivity } from "../../../lib/activity";
import { exec, q } from "../../../lib/db";
import {
  AlbumRow,
  albumOut,
  albumTheme,
  ensureAlbumsTable,
  newAlbumSlug,
  normalizeAlbumFolder,
} from "../../../lib/albums";

// ==================================================================
// ÁLBUMES DIGITALES (panel) -> /api/admin/albums
//
//   GET    ?userId=N | ?id=N   -> álbumes del cliente o uno
//   POST   { userId, title, theme, folder, eventDate, published }
//   PUT    { id, ...campos }
//   DELETE ?id=N               -> baja lógica
//
// Un álbum es una carpeta del Drive + una temática. El cliente la abre en
// `/album/<slug>` sin cuenta. La carpeta se elige en el panel con el selector
// del Drive; aquí solo se guarda su ruta.
// ==================================================================

const MODULE = "clients";
const SITE = String(process.env.PUBLIC_SITE_URL || "https://hardstreet.com");

function cleanText(raw: unknown, max: number): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  const action = req.method === "GET" ? "read" : "update";
  const me = await requireAnyOfPermissions(req, res, [
    { module: "clients", action },
    { module: "clientes", action },
  ]);
  if (!me) return;

  try {
    await ensureAlbumsTable();

    if (req.method === "GET") {
      const id = Number(req.query.id || 0);
      const userId = Number(req.query.userId || 0);
      if (!id && !userId) {
        fail(res, 400, "Falta el cliente", "Indica de qué cliente es el álbum");
        return;
      }
      const rows = await q<AlbumRow>(
        id
          ? `SELECT * FROM digital_albums WHERE id = ? AND active = 1 LIMIT 1`
          : `SELECT * FROM digital_albums
              WHERE id_user = ? AND active = 1
              ORDER BY id DESC`,
        [id || userId]
      );
      if (id && !rows.length) {
        fail(res, 404, "Álbum no encontrado", "Ese álbum ya no existe");
        return;
      }
      res.status(200).json({
        albums: rows.map((r) => albumOut(r, SITE)),
        ...(id ? { album: albumOut(rows[0], SITE) } : {}),
      });
      return;
    }

    if (req.method === "POST") {
      const b = (req.body || {}) as Record<string, unknown>;
      const userId = Number(b.userId || 0);
      const title = cleanText(b.title, 160);
      const folder = normalizeAlbumFolder(b.folder);
      if (!userId || !title || !folder) {
        fail(
          res,
          400,
          "Faltan datos",
          "Indica el cliente, el título y la carpeta del Drive"
        );
        return;
      }
      const users = await q(
        `SELECT id FROM users WHERE id = ? AND active = 1 LIMIT 1`,
        [userId]
      );
      if (!users.length) {
        fail(res, 404, "Cliente no encontrado", "Ese cliente no existe");
        return;
      }
      const slug = newAlbumSlug();
      const inserted = await exec(
        `INSERT INTO digital_albums
           (id_user, title, theme, folder, event_date, slug, published)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          title,
          albumTheme(b.theme),
          folder,
          cleanText(b.eventDate, 40),
          slug,
          b.published ? 1 : 0,
        ]
      );
      await logActivity({
        userId: me.sub,
        module: MODULE,
        moduleName: "Clientes",
        action: "create",
        entity: "album-digital",
        entityId: inserted.insertId,
        description: "Álbum digital creado",
        details: { userId, folder, slug },
        req,
      });
      const rows = await q<AlbumRow>(
        `SELECT * FROM digital_albums WHERE id = ? LIMIT 1`,
        [inserted.insertId]
      );
      created(res, "Álbum digital creado", {
        album: albumOut(rows[0], SITE),
      });
      return;
    }

    if (req.method === "PUT") {
      const b = (req.body || {}) as Record<string, unknown>;
      const id = Number(b.id || 0);
      if (!id) {
        fail(res, 400, "Falta el álbum", "Indica qué álbum quieres guardar");
        return;
      }
      const rows = await q<AlbumRow>(
        `SELECT * FROM digital_albums WHERE id = ? AND active = 1 LIMIT 1`,
        [id]
      );
      if (!rows.length) {
        fail(res, 404, "Álbum no encontrado", "Ese álbum ya no existe");
        return;
      }
      const current = rows[0];
      const title =
        b.title === undefined ? current.title : cleanText(b.title, 160);
      const folder =
        b.folder === undefined
          ? current.folder
          : normalizeAlbumFolder(b.folder);
      const theme =
        b.theme === undefined ? current.theme : albumTheme(b.theme);
      const eventDate =
        b.eventDate === undefined
          ? current.event_date
          : cleanText(b.eventDate, 40);
      const published =
        b.published === undefined
          ? Number(current.published) === 1
          : Boolean(b.published);
      const slug = String(current.slug || newAlbumSlug());

      await exec(
        `UPDATE digital_albums
            SET title = ?, theme = ?, folder = ?, event_date = ?,
                published = ?, slug = ?
          WHERE id = ?`,
        [title, theme, folder, eventDate, published ? 1 : 0, slug, id]
      );
      await logActivity({
        userId: me.sub,
        module: MODULE,
        moduleName: "Clientes",
        action: "update",
        entity: "album-digital",
        entityId: id,
        description: "Álbum digital actualizado",
        details: { folder, published },
        req,
      });
      const saved = await q<AlbumRow>(
        `SELECT * FROM digital_albums WHERE id = ? LIMIT 1`,
        [id]
      );
      ok(res, "Álbum digital guardado", {
        album: albumOut(saved[0], SITE),
      });
      return;
    }

    if (req.method === "DELETE") {
      const id = Number(req.query.id || 0);
      if (!id) {
        fail(res, 400, "Falta el álbum", "Indica qué álbum quieres eliminar");
        return;
      }
      const r = await exec(
        `UPDATE digital_albums SET active = 0, published = 0 WHERE id = ?`,
        [id]
      );
      if (!r.affectedRows) {
        fail(res, 404, "Álbum no encontrado", "Ese álbum ya no existe");
        return;
      }
      ok(res, "Álbum digital eliminado");
      return;
    }

    fail(res, 405, "Método no permitido", `${req.method} no está soportado`);
  } catch (e) {
    console.error("[admin/albums]", e);
    fail(res, 500, "Hubo un error", "No se pudo administrar el álbum digital");
  }
});
