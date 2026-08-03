import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // `pg` must stay a real Node module, not be bundled for the edge runtime.
  serverExternalPackages: ['pg'],
  images: { remotePatterns: [{ protocol: 'https', hostname: '**' }] },
};

export default nextConfig;
