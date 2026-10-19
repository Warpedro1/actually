import type { NextConfig } from "next";

// Áreas restritas e API nunca devem aparecer em buscadores.
const noindex = [{ key: "X-Robots-Tag", value: "noindex, nofollow" }];

const nextConfig: NextConfig = {
  // Pacotes do monorepo exportam TypeScript direto (sem build próprio).
  transpilePackages: ["@actually/db", "@actually/pipeline"],
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/editor/:path*", headers: noindex },
      { source: "/editor", headers: noindex },
      { source: "/admin/:path*", headers: noindex },
      { source: "/admin", headers: noindex },
      { source: "/api/:path*", headers: noindex },
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
