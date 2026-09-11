import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // API-only backend: no pages, no image optimizer
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
