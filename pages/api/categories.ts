import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../lib/cors";
import { getCategories } from "../../lib/data";
import { requestedCompanyHeader } from "../../lib/companies";

// ==================================================================
// CATEGORÍAS DEL CATÁLOGO (público) -> /api/categories
//   GET  { categories: [{ id, name, icon, urlImage }] }
//
// Lo leen la web y el panel (galería de Paquetes y selector del Sitio web).
//
// EMPRESA: cada estudio tiene sus propias categorías. Si el cliente manda
// `X-Company-Id` (el panel lo manda siempre que hay una empresa activa) se
// devuelven SÓLO las de esa empresa. Sin cabecera se devuelven todas, que es
// lo que pide la web pública (no tiene sesión ni sabe de empresas).
//
// La cabecera no se valida contra la sesión a propósito: esto es catálogo
// público (nombres, iconos y fotos que igual salen en el sitio), y así el
// panel puede pedir la empresa activa sin necesitar un token extra.
// ==================================================================

export default withCors(async (req: NextApiRequest, res: NextApiResponse) => {
  const companyId = requestedCompanyHeader(req);
  const categories = await getCategories(companyId);
  res.status(200).json({ categories });
});
