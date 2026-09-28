// ==================================================================
// HARD STREET BACKEND - Estructura del árbol de permisos del panel
// Define GRUPOS -> MÓDULOS (por url, se resuelven contra la tabla
// `modules`) -> ACCIONES (por key, se resuelven contra `permissions`).
// La fuente de verdad de los IDs es la BD; este archivo solo define
// la forma del árbol que pinta el modal del panel Flutter.
// ==================================================================

export interface AdminModuleDef {
  url: string;   // coincide con modules.url (se crea si no existe)
  name: string;
  actions: string[]; // keys de la tabla permissions (read/create/update/delete/download)
}

export interface AdminGroupDef {
  id: string;
  name: string;
  modules: AdminModuleDef[];
}

export const ADMIN_MODULES: AdminGroupDef[] = [
  {
    id: "operacion",
    name: "Operación",
    modules: [
      { url: "admin/dashboard/", name: "Dashboard", actions: ["read"] },
      { url: "admin/galerias/", name: "Galerías", actions: ["read", "create", "update", "delete"] },
      { url: "admin/reportes/", name: "Reportes", actions: ["read", "download"] },
      { url: "admin/archivos/", name: "Archivos", actions: ["read", "create", "update", "delete"] },
    ],
  },
  {
    id: "catalogos",
    name: "Catálogos",
    modules: [
      { url: "admin/paquetes/", name: "Paquetes", actions: ["read", "create", "update", "delete"] },
      { url: "admin/servicios/", name: "Servicios", actions: ["read", "create", "update", "delete"] },
      { url: "admin/categorias/", name: "Categorías", actions: ["read", "create", "update", "delete"] },
    ],
  },
  {
    id: "administracion",
    name: "Administración",
    modules: [
      { url: "admin/usuarios/", name: "Usuarios", actions: ["read", "create", "update", "delete"] },
      { url: "admin/roles/", name: "Roles", actions: ["read", "create", "update", "delete"] },
      { url: "admin/clientes/", name: "Clientes", actions: ["read", "create", "update", "delete"] },
      { url: "admin/configuraciones/", name: "Configuraciones", actions: ["read", "update"] },
    ],
  },
];

/** Etiquetas en español para las acciones (keys de permissions). */
export const ACTION_LABELS: Record<string, string> = {
  read: "Ver",
  create: "Crear",
  update: "Editar",
  delete: "Eliminar",
  download: "Descargar",
};
