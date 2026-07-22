import type { NextConfig } from 'next';

const isStaticExport = process.env.S3_STATIC_EXPORT === 'true';

const nextConfig: NextConfig = {
  output: isStaticExport ? 'export' : undefined,
  outputFileTracingRoot: process.cwd(),
  trailingSlash: isStaticExport,
  typescript: {
    tsconfigPath: isStaticExport ? 'tsconfig.s3.json' : 'tsconfig.json',
  },
  images: {
    unoptimized: isStaticExport,
  },
};

export default nextConfig;
