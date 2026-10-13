import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // API-only backend: no pages, no image optimizer
  images: { unoptimized: true },
  // Nota: en Next 16 la llave `eslint` ya no existe en NextConfig (el lint
  // corre fuera del build), por eso aquí solo queda `images`.
};

export default nextConfig;
