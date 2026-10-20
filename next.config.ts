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
      // 2026-10-20: twelve single model articles were merged into three
      // comparison articles; keep the old URLs pointing at their replacement.
      // Keep in sync with src/lib/editorial/mandarina-hub-redirects.json.
      ...([
        ["mandarina-duck-mellow-leather-fzt46", "mandarina-duck-city-bags-compared"],
        ["mandarina-duck-md20-qmt39", "mandarina-duck-city-bags-compared"],
        ["mandarina-duck-revival-2-0-oxt03", "mandarina-duck-city-bags-compared"],
        ["mandarina-duck-mellow-leather-fzt10", "mandarina-duck-city-bags-compared"],
        ["mandarina-duck-md20-leather-tktv8", "mandarina-duck-city-bags-compared"],
        ["mandarina-duck-mellow-leather-fzt82", "mandarina-duck-city-bags-compared"],
        ["mandarina-duck-revival-2-0-oxt01", "mandarina-duck-city-bags-compared"],
        ["mandarina-duck-revival-2-0-oxm04", "mandarina-duck-pouches-toiletry-compared"],
        ["mandarina-duck-md20-qmmo1", "mandarina-duck-pouches-toiletry-compared"],
        ["mandarina-duck-eco-coated-osn02", "mandarina-duck-pouches-toiletry-compared"],
        ["mandarina-duck-eco-coated-osv04", "mandarina-duck-suitcase-and-weekender"],
        ["mandarina-duck-revival-2-0-oxb01", "mandarina-duck-suitcase-and-weekender"],
      ] as const).map(([from, to]) => ({
        source: `/journal/${from}`,
        destination: `/journal/${to}`,
        permanent: true,
      })),
    ];
  },
  images: {
    formats: ["image/avif", "image/webp"],
    qualities: [60, 75, 85, 100],
    minimumCacheTTL: 2678400,
    remotePatterns: [
      { protocol: 'https', hostname: 'cdn.shopify.com', pathname: '/s/files/1/0622/8082/7130/**' },
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
