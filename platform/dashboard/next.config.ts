import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The Docker image runs the dashboard standalone, without node_modules.
  output: 'standalone',
};

export default config;
