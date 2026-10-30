import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // API-only backend: no pages, no image optimizer
  images: { unoptimized: true },
  // Nota: en Next 16 la llave `eslint` ya no existe en NextConfig (el lint
  // corre fuera del build), por eso aquí solo queda `images`.

  // LIGA CORTA DE UNA INVITACIÓN: `/i/<slug>` sirve el HTML guardado. La
  // ruta bonita es la que se comparte con el cliente; por dentro es el
  // endpoint público (que comprueba que esté publicada y activa).
  async rewrites() {
    return [
      {
        source: "/i/:slug",
        destination: "/api/invitations/public?slug=:slug",
      },
    ];
  },
};

export default nextConfig;
