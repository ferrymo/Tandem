import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // antd 的 cssinjs 在 prerender 期使用 Math.random()，与 cacheComponents 严格预渲染不兼容，故关闭
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://localhost:3300/api/:path*",
      },
    ];
  },
};

export default nextConfig;
