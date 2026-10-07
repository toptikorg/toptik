import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Keep private/admin surfaces out of search while allowing public pages.
        source: "/:path*",
        has: [{ type: "host", value: "admin.toptik.co.il" }],
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      ...["admin", "dashboard", "settings", "setup", "login", "reset", "auth"].map((path) => ({
        source: `/${path}/:path*`,
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      })),
      // The image route sets its own result-specific directive after validating
      // and decoding a catalog photo. A blanket API header overrides that value.
      ...["/api", "/api/:path((?!img-trim$).*)"].map((source) => ({
        source,
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      })),
    ];
  },
  async redirects() {
    return [
      ...["site.toptik.co.il", "toptik-iota.vercel.app"].map((host) => ({
        source: "/:path*",
        has: [{ type: "host" as const, value: host }],
        destination: "https://landing.toptik.co.il/:path*",
        permanent: true,
      })),
    ];
  },
  images: {
    formats: ["image/avif", "image/webp"],
    qualities: [60, 75, 85, 100],
    minimumCacheTTL: 2678400,
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
    ],
    localPatterns: [
      {
        pathname: "/**",
      },
    ],
  },
};

export default nextConfig;
