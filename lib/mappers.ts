// ==================================================================
// HARD STREET BACKEND - Mappers (filas DB -> modelos del frontend)
// El frontend consume exactamente estos modelos:
//   Service, Tier, PackageCategory, Status, Package, PurchasedPackage,
//   PurchasedPackageService, User, Gallery
// ==================================================================

// ---------- Row types (snake_case tal cual la BD) ----------
export interface ServiceRow { id: number; name: string | null; description: string | null; icon: string | null; }
export interface TierRow { id: number; name: string | null; tier: number | null; }
export interface PackageCategoryRow { id: number; name: string | null; icon: string | null; }
export interface StatusRow { id: number; name: string | null; }
export interface PackageRow {
  id: number; name: string | null; subtitle: string | null; description: string | null;
  price: string | number | null; currency: string | null;
  id_tier: number | null; id_package_category: number | null; is_extern: number | null;
  url_image?: string | null;
}
export interface PurchasedPackageRow {
  id: number; name: string | null; subtitle: string | null; description: string | null;
  price: string | number | null; currency: string | null; paid: string | number | null;
  id_status: number | null; id_package: number | null; id_package_category: number | null; id_tier: number | null;
}
export interface PurchasedPackageServiceRow {
  id: number; description: string | null; delivery_date: number | null;
  id_purchased_package: number | null; id_status: number | null; id_service: number | null;
}
export interface UserRow {
  id: number; name: string | null; lastname: string | null; number: string | null;
  email: string | null; id_role: number | null;
}
export interface GalleryRow {
  id: number; url: string | null; id_user: number | null; id_gallery_type: number | null;
  id_purchased_package: number | null; id_package_category: number | null; is_public: number | null;
}
export interface RoleRow { id: number; name: string | null; }

// ---------- Model types (camelCase, para el frontend) ----------
export interface Tier { id: number; name: string; tier: number; }
export interface PackageCategory { id: number; name: string; icon: string; }
export interface Status { id: number; name: string; }
export interface Service { id: number; name: string; description: string; icon: string; }

export interface Package {
  id: number;
  name: string;
  subtitle: string;
  description: string;
  price: number;
  currency: string;
  tier: Tier;
  packageCategory: PackageCategory;
  isExtern: boolean;
  urlImage: string;      // url_image (carousel "Nuestros servicios")
  services: Service[];
}

export interface PurchasedPackageService {
  id: number;
  description: string;      // nota de avance del servicio (del admin)
  deliveryDate: number | null; // dias de entrega
  status: Status;
  service: Service;
}

export interface PurchasedPackage {
  id: number;
  name: string;
  subtitle: string;
  description: string;
  price: number;   // precio total acordado (heredado del paquete)
  paid: number;    // lo que el cliente ya ha pagado
  currency: string;
  status: Status;  // estado global de la compra
  package: Package; // paquete principal del que hereda
  services: PurchasedPackageService[];
}

export interface User {
  id: number;
  name: string;
  lastname: string;
  number: string;
  email: string;
  role: string;
}

export interface Gallery {
  id: number;
  url: string;
  user: number;               // id_user
  galleryType: string;        // name de galleries_types
  purchasedPackage: number | null; // id_purchased_package
  packageCategory: number | null;  // id_package_category
  packageCategoryName: string;     // name de packages_categories (para filtros)
  isPublic: boolean;
}

// ---------- Helpers ----------
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

export function mapTier(r: TierRow): Tier {
  return { id: r.id, name: str(r.name), tier: num(r.tier) };
}

export function mapPackageCategory(r: PackageCategoryRow): PackageCategory {
  return { id: r.id, name: str(r.name), icon: str(r.icon) };
}

export function mapStatus(r: StatusRow): Status {
  return { id: r.id, name: str(r.name) };
}

export function mapService(r: ServiceRow): Service {
  return { id: r.id, name: str(r.name), description: str(r.description), icon: str(r.icon) };
}

export function mapPackage(
  r: PackageRow,
  tier?: TierRow | null,
  category?: PackageCategoryRow | null,
  services: ServiceRow[] = []
): Package {
  return {
    id: r.id,
    name: str(r.name),
    subtitle: str(r.subtitle),
    description: str(r.description),
    price: num(r.price),
    currency: str(r.currency) || "MXN",
    tier: tier ? mapTier(tier) : { id: 0, name: "Basic", tier: 3 },
    packageCategory: category
      ? mapPackageCategory(category)
      : { id: 0, name: "General", icon: "" },
    isExtern: Number(r.is_extern) === 1,
    urlImage: str(r.url_image),
    services: services.map(mapService),
  };
}

export function mapPurchasedPackageService(
  r: PurchasedPackageServiceRow,
  service?: ServiceRow | null,
  status?: StatusRow | null
): PurchasedPackageService {
  return {
    id: r.id,
    description: str(r.description),
    deliveryDate: r.delivery_date === null || r.delivery_date === undefined ? null : num(r.delivery_date),
    status: status ? mapStatus(status) : { id: 0, name: "Pendiente" },
    service: service ? mapService(service) : { id: 0, name: "", description: "", icon: "" },
  };
}

export function mapPurchasedPackage(
  r: PurchasedPackageRow,
  pkg?: Package | null,
  services: PurchasedPackageService[] = [],
  status?: StatusRow | null
): PurchasedPackage {
  return {
    id: r.id,
    name: str(r.name),
    subtitle: str(r.subtitle),
    description: str(r.description),
    price: num(r.price),
    paid: num(r.paid),
    currency: str(r.currency) || "MXN",
    status: status ? mapStatus(status) : { id: 0, name: "Pendiente" },
    package: pkg || {
      id: 0, name: "", subtitle: "", description: "",
      price: num(r.price), currency: str(r.currency) || "MXN",
      tier: { id: 0, name: "Basic", tier: 3 },
      packageCategory: { id: 0, name: "General", icon: "" },
      isExtern: false, urlImage: "", services: [],
    },
    services,
  };
}

export function mapUser(r: UserRow, role?: RoleRow | null): User {
  return {
    id: r.id,
    name: str(r.name),
    lastname: str(r.lastname),
    number: str(r.number),
    email: str(r.email),
    role: role ? str(role.name) : "",
  };
}

export function mapGallery(r: GalleryRow, typeName?: string | null, categoryName?: string | null): Gallery {
  return {
    id: r.id,
    url: str(r.url),
    user: num(r.id_user),
    galleryType: str(typeName) || "image",
    purchasedPackage: r.id_purchased_package === null ? null : num(r.id_purchased_package),
    packageCategory: r.id_package_category === null ? null : num(r.id_package_category),
    packageCategoryName: str(categoryName),
    isPublic: Number(r.is_public) === 1,
  };
}
