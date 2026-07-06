import type { NextConfig } from "next";

// Only allow localhost or 127.0.0.1 destinations for the rewrite
function validateRewriteUrl(url: string): string {
  const allowed = ["http://localhost", "http://127.0.0.1"]
  for (const prefix of allowed) {
    if (url.startsWith(prefix)) return url
  }
  return "http://localhost:4096"
}

const HELIX_SERVER_URL = validateRewriteUrl(process.env.OPENCODE_SERVER_URL || "http://localhost:4096")

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: true,
  devIndicators: false,
  serverExternalPackages: ['playwright'],
  async rewrites() {
    return [
      {
        source: "/helix/:path*",
        destination: `${HELIX_SERVER_URL}/:path*`,
      },
    ];
  },
};

export default nextConfig;
