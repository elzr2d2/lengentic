/**
 * Negative fixture for `pnpm check:boundaries`: proves the boundary rules fire on a BARE
 * workspace specifier (`import ... from '@lengentic/database'`), not only on a relative
 * deep import.
 *
 * Why this exists: every workspace package's `exports` map resolves to `dist/`, and the
 * cruise excludes `dist`, so before tsconfig.depcruise.json aliased the specifiers to source
 * every cross-package edge was dropped before any rule saw it and the gate cruised clean
 * over the exact imports CLAUDE.md says it forbids. A green that lies.
 *
 * Mechanism: write one probe file per guarded boundary into the real tree (rules match on
 * path, so the probe has to live where the violation would), cruise only those files, assert
 * each expected rule fires from its probe, and delete the probes whatever happens.
 */

import { rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const PROBE = '__boundary_probe__.ts';

interface Probe {
  file: string;
  specifier: string;
  expectRules: string[];
}

const PROBES: Probe[] = [
  {
    file: `playground/${PROBE}`,
    specifier: '@lengentic/database',
    expectRules: ['playground-not-to-other-platform-packages'],
  },
  {
    file: `platform/telemetry-sdk/src/${PROBE}`,
    specifier: '@lengentic/database',
    expectRules: ['sdk-depends-on-shared-only', 'no-prisma-in-the-wire-contract'],
  },
  {
    file: `platform/shared/${PROBE}`,
    specifier: '@lengentic/telemetry-sdk',
    expectRules: ['shared-schema-is-the-wire-contract'],
  },
  {
    file: `platform/analysis-engine/src/${PROBE}`,
    specifier: '@lengentic/database',
    expectRules: ['analysis-engine-is-pure'],
  },
];

interface Violation {
  from: string;
  to: string;
  rule: { name: string };
}

function cruise(files: string[]): Violation[] {
  // The package `exports` map hides bin/ and package.json; it is a root devDependency.
  const bin = join(REPO, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruise.mjs');
  const result = spawnSync(
    process.execPath,
    [bin, ...files, '--config', '.dependency-cruiser.cjs', '--output-type', 'json'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  const parsed = JSON.parse(result.stdout) as { summary: { violations: Violation[] } };
  return parsed.summary.violations;
}

function main(): number {
  const written: string[] = [];
  let violations: Violation[];
  try {
    for (const p of PROBES) {
      // 'wx': never overwrite a real file that happens to share the probe name.
      writeFileSync(join(REPO, p.file), `export * from '${p.specifier}';\n`, { flag: 'wx' });
      written.push(p.file);
    }
    violations = cruise(PROBES.map((p) => p.file));
  } finally {
    for (const file of written) rmSync(join(REPO, file), { force: true });
  }

  let failures = 0;
  for (const p of PROBES) {
    for (const rule of p.expectRules) {
      const hit = violations.some((v) => v.from === p.file && v.rule.name === rule);
      const line = `${p.file} -> '${p.specifier}' fires ${rule}`;
      if (hit) {
        console.log(`  PASS ${line}`);
      } else {
        failures += 1;
        console.error(`  FAIL ${line}: not reported`);
      }
    }
  }
  if (failures > 0) {
    console.error(`check:boundaries selftest FAILED: ${failures} expected violation(s) missing`);
    return 1;
  }
  console.log('check:boundaries selftest passed: bare workspace specifiers reach the rules.');
  return 0;
}

process.exitCode = main();
