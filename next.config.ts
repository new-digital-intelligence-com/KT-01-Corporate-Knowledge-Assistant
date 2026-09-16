import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A self-contained server in .next/standalone, which the Dockerfile packs for Cloud Run. Vercel builds its own way.
  output: process.env.VERCEL ? undefined : "standalone",
};

export default nextConfig;
