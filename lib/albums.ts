import { randomBytes } from "crypto";
import { q, exec } from "./db";
import { driveList, DriveEntry } from "./drive-service";

// ==================================================================
// ÁLBUM DIGITAL — fotos y vídeos de una carpeta del Drive
//
// Un álbum es una CARPETA del Drive + una temática (`boda`, `xv`, `clasico`)
// + una liga pública. No copia archivos: los lee de la carpeta cada vez que
// alguien abre la liga, así que lo que el estudio suba al Drive aparece solo.
//
// La tabla `digital_albums` guarda la carpeta, la temática y el estado. Los
// archivos NUNCA se guardan en la base.
// ==================================================================

export type AlbumTheme = "boda" | "xv" | "clasico";
export const ALBUM_THEMES: AlbumTheme[] = ["boda", "xv", "clasico"];

export type AlbumRow = {
  id: number;
  id_user: number | null;
  title: string | null;
  theme: string | null;
  folder: string | null;
  event_date: string | null;
  slug: string | null;
  published: number | null;
  active: number | null;
  created_at?: string;
};

let tableReady = false;

export async function ensureAlbumsTable(): Promise<void> {
  if (tableReady) return;
  await exec(
    `CREATE TABLE IF NOT EXISTS digital_albums (
       id INT UNSIGNED NOT NULL AUTO_INCREMENT,
       id_user INT NULL,
       title VARCHAR(160) NOT NULL DEFAULT '',
       theme VARCHAR(20) NOT NULL DEFAULT 'boda',
       folder VARCHAR(700) NOT NULL DEFAULT '',
       event_date VARCHAR(40) NOT NULL DEFAULT '',
       slug VARCHAR(40) NOT NULL,
       published TINYINT(1) NOT NULL DEFAULT 0,
       active TINYINT(1) NOT NULL DEFAULT 1,
       created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uq_digital_album_slug (slug),
       KEY idx_digital_album_user (id_user, active)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  );
  tableReady = true;
}

/** Liga corta y única para el álbum. */
export function newAlbumSlug(): string {
  return randomBytes(5).toString("hex");
}

/** Carpeta normalizada ('' si no queda nada útil). */
export function normalizeAlbumFolder(raw: unknown): string {
  return String(raw ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== ".." && !s.startsWith("."))
    .join("/");
}

export function albumTheme(raw: unknown): AlbumTheme {
  const clean = String(raw ?? "").trim().toLowerCase();
  return (ALBUM_THEMES as string[]).includes(clean)
    ? (clean as AlbumTheme)
    : "boda";
}

export function albumOut(row: AlbumRow, siteBase: string) {
  const slug = String(row.slug ?? "");
  return {
    id: Number(row.id),
    userId: Number(row.id_user || 0),
    title: String(row.title ?? ""),
    theme: albumTheme(row.theme),
    folder: String(row.folder ?? ""),
    eventDate: String(row.event_date ?? ""),
    slug,
    published: Number(row.published) === 1,
    active: Number(row.active) === 1,
    url: slug ? `${siteBase.replace(/\/+$/, "")}/album/${slug}` : "",
    createdAt: row.created_at ?? "",
  };
}

export type AlbumItem = {
  name: string;
  kind: "image" | "video";
  size: number;
  modified: number;
};

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|heic|bmp|tiff?)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|ogv|avi|mkv|mts|m2ts)$/i;

/** Clasifica un archivo por su nombre (el `kind` del Drive ayuda). */
export function albumItemKind(name: string, kind?: string): "image" | "video" | "" {
  if (kind === "image" || IMAGE_EXT.test(name)) return "image";
  if (kind === "video" || VIDEO_EXT.test(name)) return "video";
  return "";
}

/** Lista los archivos de una carpeta que el álbum puede mostrar. */
export async function listAlbumItems(folder: string): Promise<AlbumItem[]> {
  const entries: DriveEntry[] = await driveList(folder);
  const out: AlbumItem[] = [];
  for (const e of entries) {
    if (e.isFolder) continue;
    const kind = albumItemKind(String(e.name || ""), e.kind);
    if (!kind) continue;
    out.push({
      name: String(e.name),
      kind,
      size: Number(e.size || 0),
      modified: Number(e.modified || 0),
    });
    if (out.length >= 600) break;
  }
  // Los más recientes primero: así las fotos nuevas salen arriba.
  out.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
  return out;
}

/** Fila de un álbum por liga, solo si está publicada. */
export async function publicAlbum(slug: string): Promise<AlbumRow | null> {
  await ensureAlbumsTable();
  const rows = await q<AlbumRow>(
    `SELECT id, id_user, title, theme, folder, event_date, slug,
            published, active, created_at
       FROM digital_albums
      WHERE slug = ? AND published = 1 AND active = 1
      LIMIT 1`,
    [slug]
  );
  return rows[0] ?? null;
}
