import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,

  // The Docker image runs the dashboard standalone, without node_modules.
  output: 'standalone',

  // In a pnpm workspace, Next traces from the nearest lockfile and warns that it guessed.
  // Pointing it at the repository root makes the standalone layout deterministic, which
  // is what dashboard.Dockerfile's COPY paths depend on.
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
};

export default config;
