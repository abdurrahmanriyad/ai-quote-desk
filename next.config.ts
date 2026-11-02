import type { NextConfig } from 'next';

const config: NextConfig = {
  serverExternalPackages: ['pg', 'bullmq', 'ioredis', 'pdf-lib'],
  experimental: { serverActions: { bodySizeLimit: '21mb' } },
};

export default config;
