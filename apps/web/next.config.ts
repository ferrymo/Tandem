import type { NextConfig } from 'next';
import path from 'node:path';
const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.resolve(import.meta.dirname, '../..'),
  transpilePackages: [
    '@tandem/core',
    '@tandem/application',
    '@tandem/platform',
    '@tandem/storage-postgres',
    '@tandem/zentao',
    '@tandem/capabilities',
    '@tandem/execution',
    '@tandem/mcp-client',
  ],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },
};
export default config;
