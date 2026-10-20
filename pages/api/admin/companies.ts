import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";
import { requireSuperAdmin } from "../../../lib/permissions";
import {
  createCompany,
  getCompany,
  listCompanies,
  updateCompany,
} from "../../../lib/companies";
import { created, fail, ok } from "../../../lib/api-response";

// ==================================================================
// EMPRESAS  ->  /api/admin/companies
//   GET  lista las empresas con sus administradores y conteos
//   POST crea una empresa ({ name, folderPath?, color? })
//   PUT  actualiza ({ id, name?, folderPath?, color?, active? })
//   DELETE desactiva ({ id })
//
// SOLO el Superadministrador puede usar este endpoint y solo él ve la
// carpeta raíz del Drive: cada empresa está encerrada en SU carpeta.
// ==================================================================

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  const me = await requireSuperAdmin(req, res);
  if (!me) return;

  try {
    if (req.method === "GET") {
      const companies = await listCompanies();
      ok(res, "Empresas cargadas", { companies });
      return;
    }

    const body = (req.body || {}) as Record<string, unknown>;

    if (req.method === "POST") {
      const id = await createCompany({
        name: String(body.name ?? ""),
        folderPath: String(body.folderPath ?? ""),
        color: body.color == null ? null : String(body.color),
      });
      const company = await getCompany(id);
      created(res, `Empresa "${company?.name ?? ""}" creada`, {
        item: company,
        company,
      });
      return;
    }

    if (req.method === "PUT") {
      const id = Number(body.id || 0);
      if (!id) {
        fail(res, 400, "Falta la empresa", "Indica qué empresa se edita");
        return;
      }
      if (id === 1 && body.active !== undefined && Number(body.active) === 0) {
        fail(
          res,
          409,
          "La empresa principal no se puede desactivar",
          "Renómbrala o edita sus datos, pero debe seguir activa"
        );
        return;
      }
      const changed = await updateCompany(id, {
        name: body.name,
        folderPath: body.folderPath,
        color: body.color,
        active: body.active,
      });
      if (!changed) {
        fail(res, 404, "No hubo cambios", "La empresa no existe o no enviaste datos nuevos");
        return;
      }
      const company = await getCompany(id);
      ok(res, `Empresa "${company?.name ?? ""}" actualizada`, {
        item: company,
        company,
      });
      return;
    }

    if (req.method === "DELETE") {
      const id = Number(body.id || req.query.id || 0);
      if (!id) {
        fail(res, 400, "Falta la empresa", "Indica qué empresa se desactiva");
        return;
      }
      if (id === 1) {
        fail(
          res,
          409,
          "La empresa principal no se puede desactivar",
          "Es la empresa que conserva los datos originales del estudio"
        );
        return;
      }
      await updateCompany(id, { active: false });
      ok(res, "Empresa desactivada", { item: null, id });
      return;
    }

    fail(res, 405, "Método no permitido", `${req.method} no está soportado aquí`);
  } catch (e) {
    console.error("[admin/companies]", e);
    fail(
      res,
      400,
      "No se pudo guardar la empresa",
      e instanceof Error ? e.message : String(e)
    );
  }
});
