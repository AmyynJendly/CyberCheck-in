import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // pg / nodemailer / qrcode / exceljs are Node-only; keep them out of the bundle.
  serverExternalPackages: ["pg", "nodemailer", "qrcode", "bcryptjs", "exceljs"],
  eslint: { ignoreDuringBuilds: true }, // type safety is enforced by `npm run typecheck`
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
        ],
      },
      {
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache" }],
      },
    ];
  },
};

export default nextConfig;
