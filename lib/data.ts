// ==================================================================
// HARD STREET BACKEND - Consultas de datos
// ==================================================================
import { q } from "./db";
import {
  mapPackage, mapPurchasedPackage, mapPurchasedPackageService,
  mapPackageCategory, mapTier, mapStatus, mapService, mapGallery,
  PackageRow, TierRow, PackageCategoryRow, PurchasedPackageRow,
  PurchasedPackageServiceRow, StatusRow,
  Package, PurchasedPackage, PackageCategory, Tier,
  ServiceRow, GalleryRow,
} from "./mappers";

// ---------- Catalogo: categorias ----------
export async function getCategories(): Promise<PackageCategory[]> {
  const rows = await q<PackageCategoryRow>(
    `SELECT id, name, icon FROM packages_categories WHERE active = 1 ORDER BY id`
  );
  return rows.map(mapPackageCategory);
}

// ---------- Catalogo: tiers ----------
export async function getTiers(): Promise<Tier[]> {
  const rows = await q<TierRow>(`SELECT id, name, tier FROM tiers WHERE active = 1 ORDER BY tier ASC`);
  return rows.map(mapTier);
}

// ---------- Catalogo: paquetes (con tier, categoria y servicios) ----------
export async function getPackages(opts: { extern?: boolean; category?: string } = {}): Promise<Package[]> {
  const params: unknown[] = [];
  const where: string[] = [`p.active = 1`];

  if (opts.extern !== undefined) {
    params.push(opts.extern ? 1 : 0);
    where.push(`p.is_extern = ?`);
  }
  if (opts.category) {
    params.push(opts.category);
    where.push(`LOWER(pc.name) = LOWER(?)`);
  }

  const rows = await q<PackageRow & { tier_name: string | null; tier_num: number | null; cat_name: string | null; cat_icon: string | null }>(
    `SELECT p.id, p.name, p.subtitle, p.description, p.price, p.currency,
            p.id_tier, p.id_package_category, p.is_extern, p.url_image,
            t.name AS tier_name, t.tier AS tier_num,
            pc.name AS cat_name, pc.icon AS cat_icon
       FROM packages p
       LEFT JOIN tiers t ON t.id = p.id_tier
       LEFT JOIN packages_categories pc ON pc.id = p.id_package_category
      WHERE ${where.join(" AND ")}
      ORDER BY t.tier IS NULL ASC, t.tier ASC, p.id ASC`,
    params
  );

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const svcRows = await q<{ id_package: number; id: number; name: string | null; description: string | null; icon: string | null }>(
    `SELECT ps.id_package, s.id, s.name, s.description, s.icon
       FROM packages_services ps
       JOIN services s ON s.id = ps.id_service AND s.active = 1
      WHERE ps.active = 1 AND ps.id_package IN (?)
      ORDER BY ps.id ASC`,
    [ids]
  );

  return rows.map((r) =>
    mapPackage(
      r,
      { id: r.id_tier || 0, name: r.tier_name || "Basic", tier: r.tier_num || 3 },
      { id: r.id_package_category || 0, name: r.cat_name || "General", icon: r.cat_icon || "" },
      svcRows.filter((s) => s.id_package === r.id)
    )
  );
}

// ---------- Catalogo: servicios ----------
export async function getServices() {
  const rows = await q<ServiceRow>(`SELECT id, name, description, icon FROM services WHERE active = 1 ORDER BY id`);
  return rows.map(mapService);
}

// ---------- Cliente: paquetes comprados de un usuario ----------
export async function getPurchasedPackagesByUser(userId: number): Promise<PurchasedPackage[]> {
  const ppRows = await q<PurchasedPackageRow>(
    `SELECT pp.id, pp.name, pp.subtitle, pp.description, pp.price, pp.currency, pp.paid,
            pp.id_status, pp.id_package, pp.id_package_category, pp.id_tier
       FROM users_packages up
       JOIN purchased_packages pp ON pp.id = up.id_purchased_package AND pp.active = 1
      WHERE up.id_user = ? AND up.active = 1
      ORDER BY pp.id DESC`,
    [userId]
  );
  if (ppRows.length === 0) return [];

  const ppIds = ppRows.map((r) => r.id);

  // Servicios comprados + su servicio base + estatus
  const svcRows = await q<PurchasedPackageServiceRow & { svc_name: string | null; svc_description: string | null; svc_icon: string | null; status_name: string | null }>(
    `SELECT pps.id, pps.description, pps.delivery_date, pps.id_purchased_package, pps.id_status, pps.id_service,
            s.name AS svc_name, s.description AS svc_description, s.icon AS svc_icon,
            st.name AS status_name
       FROM purchased_packages_services pps
       LEFT JOIN services s ON s.id = pps.id_service
       LEFT JOIN status st ON st.id = pps.id_status
      WHERE pps.active = 1 AND pps.id_purchased_package IN (?)
      ORDER BY pps.id ASC`,
    [ppIds]
  );

  // Paquetes principales (para heredar datos) + estatus global de la compra
  const pkgIds = [...new Set(ppRows.map((r) => r.id_package).filter((v): v is number => !!v))];
  const stIds = [...new Set(ppRows.map((r) => r.id_status).filter((v): v is number => !!v))];

  const pkgRows = pkgIds.length
    ? await q<PackageRow & { tier_name: string | null; tier_num: number | null; cat_name: string | null; cat_icon: string | null }>(
        `SELECT p.id, p.name, p.subtitle, p.description, p.price, p.currency,
                p.id_tier, p.id_package_category, p.is_extern, p.url_image,
                t.name AS tier_name, t.tier AS tier_num,
                pc.name AS cat_name, pc.icon AS cat_icon
           FROM packages p
           LEFT JOIN tiers t ON t.id = p.id_tier
           LEFT JOIN packages_categories pc ON pc.id = p.id_package_category           WHERE p.id IN (?)`,
        [pkgIds]
      )
    : [];

  const baseSvcRows = pkgIds.length
    ? await q<{ id_package: number; id: number; name: string | null; description: string | null; icon: string | null }>(
        `SELECT ps.id_package, s.id, s.name, s.description, s.icon
           FROM packages_services ps
           JOIN services s ON s.id = ps.id_service AND s.active = 1
          WHERE ps.active = 1 AND ps.id_package IN (?)
          ORDER BY ps.id ASC`,
        [pkgIds]
      )
    : [];

  const stRows = stIds.length
    ? await q<StatusRow>(`SELECT id, name FROM status WHERE id IN (?)`, [stIds])
    : [];

  return ppRows.map((r) => {
    const pkgRow = pkgRows.find((p) => p.id === r.id_package) || null;
    const pkg: Package = pkgRow
      ? mapPackage(
          pkgRow,
          { id: pkgRow.id_tier || 0, name: pkgRow.tier_name || "Basic", tier: pkgRow.tier_num || 3 },
          { id: pkgRow.id_package_category || 0, name: pkgRow.cat_name || "General", icon: pkgRow.cat_icon || "" },
          baseSvcRows.filter((s) => s.id_package === pkgRow.id)
        )
      : null;

    const services = svcRows
      .filter((s) => s.id_purchased_package === r.id)
      .map((s) =>
        mapPurchasedPackageService(
          s,
          s.svc_name
            ? { id: s.id_service || 0, name: s.svc_name, description: s.svc_description || "", icon: s.svc_icon || "" }
            : null,
          s.status_name ? { id: s.id_status || 0, name: s.status_name } : null
        )
      );

    const st = stRows.find((s) => s.id === r.id_status) || null;
    return mapPurchasedPackage(r, pkg, services, st);
  });
}

// ---------- Cliente: galeria de un usuario ----------
export async function getGalleriesByUser(userId: number) {
  const rows = await q<GalleryRow & { type_name: string | null; cat_name: string | null }>(
    `SELECT g.id, g.url, g.id_user, g.id_gallery_type, g.id_purchased_package, g.id_package_category, g.is_public,
            gt.name AS type_name, pc.name AS cat_name
       FROM galleries g
       LEFT JOIN galleries_types gt ON gt.id = g.id_gallery_type
       LEFT JOIN packages_categories pc ON pc.id = g.id_package_category
      WHERE g.active = 1 AND g.id_user = ?
      ORDER BY g.id DESC`,
    [userId]
  );
  return rows.map((r) => mapGallery(r, r.type_name, r.cat_name));
}

// ---------- Publico: galeria publica (landing "Galeria Destacada") ----------
// Incluye el nombre de la categoria (packages_categories) para los filtros.
export async function getPublicGalleries() {
  const rows = await q<GalleryRow & { type_name: string | null; cat_name: string | null }>(
    `SELECT g.id, g.url, g.id_user, g.id_gallery_type, g.id_purchased_package, g.id_package_category, g.is_public,
            gt.name AS type_name, pc.name AS cat_name
       FROM galleries g
       LEFT JOIN galleries_types gt ON gt.id = g.id_gallery_type
       LEFT JOIN packages_categories pc ON pc.id = g.id_package_category
      WHERE g.active = 1 AND g.is_public = 1
      ORDER BY g.id DESC
      LIMIT 24`,
    [ ]
  );
  return rows.map((r) => mapGallery(r, r.type_name, r.cat_name));
}

export { mapStatus, mapGallery };
