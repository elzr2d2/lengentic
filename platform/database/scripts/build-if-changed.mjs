// Build cache for @lengentic/database. `prisma generate && tsc` costs ~10s and runs on
// every gates invocation; the inputs change perhaps once a wave. Hash the inputs, stamp
// them after a successful build, and skip the build when nothing moved.
//
// A successful build IS the typecheck for this package (tsc emits or errors), which is
// why package.json points both `build` and `typecheck` here.
//
// Deliberately dependency-free and plain-console: this is build tooling like tsc itself,
// not harness telemetry — no scripts/lib/log.ts, no tsx.
//
// Override: LENGENTIC_DB_FORCE_BUILD=1 always rebuilds.

import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Everything the build reads. src/** includes src/generated/prisma, which `prisma
// generate` rewrites — that is why the stamp is computed AFTER the build, over the
// post-generate tree, so an unchanged schema hashes stable on the next run.
const INPUT_PATHS = ['prisma', 'src', 'tsconfig.json', 'package.json'];

// Everything the build must have produced for a skip to be safe.
const OUTPUT_PATHS = ['dist/index.js', 'dist/index.d.ts', 'src/generated/prisma'];

const STAMP_PATH = path.join(pkgRoot, 'node_modules', '.cache', 'build-stamp.json');

function walkSorted(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkSorted(abs));
    else if (entry.isFile()) files.push(abs);
  }
  return files;
}

function hashInputs() {
  const h = createHash('sha256');
  for (const rel of INPUT_PATHS) {
    const abs = path.join(pkgRoot, rel);
    if (!existsSync(abs)) {
      h.update(`missing:${rel}\n`);
      continue;
    }
    const files = statSync(abs).isDirectory() ? walkSorted(abs) : [abs];
    for (const file of files) {
      h.update(path.relative(pkgRoot, file).replaceAll('\\', '/') + '\n');
      h.update(readFileSync(file));
    }
  }
  return h.digest('hex');
}

function readStamp() {
  try {
    return JSON.parse(readFileSync(STAMP_PATH, 'utf8'));
  } catch {
    return null;
  }
}

const force = process.env.LENGENTIC_DB_FORCE_BUILD === '1';
const outputsExist = OUTPUT_PATHS.every((rel) => existsSync(path.join(pkgRoot, rel)));
const currentHash = hashInputs();
const stamp = readStamp();

if (!force && outputsExist && stamp?.hash === currentHash) {
  console.log('[database] build unchanged (stamp match) — skipping prisma generate + tsc');
  process.exit(0);
}

if (force) console.log('[database] LENGENTIC_DB_FORCE_BUILD=1 — rebuilding');

execSync('pnpm exec prisma generate', { cwd: pkgRoot, stdio: 'inherit' });
execSync('pnpm exec tsc -p tsconfig.json', { cwd: pkgRoot, stdio: 'inherit' });

mkdirSync(path.dirname(STAMP_PATH), { recursive: true });
writeFileSync(
  STAMP_PATH,
  JSON.stringify({ hash: hashInputs(), builtAt: new Date().toISOString() }, null, 2) + '\n',
);
console.log('[database] build complete — stamp written');
