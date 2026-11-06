import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression pins for the two defects the clean-clone rehearsal (p7.docker-smoke) found.
 * The seam is the committed Docker config text: a clean `docker compose up` must build the
 * api image (shared + analysis-engine copied and built) and migrate before the api starts.
 * The end-to-end proof stays the rehearsal; these keep the fixes from silently reverting.
 */
const root = resolve(__dirname, '../../..');
const dockerfile = readFileSync(resolve(root, 'docker/api.Dockerfile'), 'utf8');
const compose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');

describe('docker/api.Dockerfile', () => {
  for (const pkg of ['shared', 'analysis-engine']) {
    it(`copies and builds @lengentic/${pkg} before the api`, () => {
      expect(dockerfile).toContain(`COPY platform/${pkg} ./platform/${pkg}`);
      const built = dockerfile.indexOf(`pnpm --filter @lengentic/${pkg} build`);
      const apiBuilt = dockerfile.indexOf('pnpm --filter @lengentic/api build');
      expect(built).toBeGreaterThan(-1);
      expect(built).toBeLessThan(apiBuilt);
    });
  }
});

describe('docker-compose.yml', () => {
  it('defines a one-shot migrate service that runs migrations', () => {
    expect(compose).toMatch(/^ {2}migrate:/m);
    expect(compose).toContain('db:migrate:deploy');
    expect(compose).toMatch(/restart: 'no'/);
  });

  it('gates the api on migrate completing successfully', () => {
    const api = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  dashboard:'));
    expect(api).toMatch(/migrate:\s*\n\s*condition: service_completed_successfully/);
  });
});
