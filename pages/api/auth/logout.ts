import type { NextApiRequest, NextApiResponse } from "next";
import { withCors } from "../../../lib/cors";

// El JWT viaja en el header Authorization, asi que no hay sesion que
// invalidar en el servidor: el cliente simplemente descarta su token.
export default withCors(async (_req: NextApiRequest, res: NextApiResponse) => {
  res.status(200).json({ ok: true });
});
