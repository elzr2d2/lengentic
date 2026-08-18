// Wires git's hooksPath to .husky/ so pre-commit runs pnpm gates:full.
// No-ops outside a real git checkout (e.g. check:isolation's Arm 1 temp
// checkout, which deliberately excludes .git) so a plain `pnpm install`
// there does not fail the lifecycle script.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('.git')) {
  execSync('git config core.hooksPath .husky', { stdio: 'inherit' });
}
