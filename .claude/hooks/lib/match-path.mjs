/**
 * Path-pattern matching for lane ownership.
 *
 * Node built-ins only, and no import from `scripts/` — same reason `validate-schema.mjs`
 * reimplements a JSON Schema subset instead of depending on ajv. A hook that only works
 * after `pnpm install` has succeeded fails exactly when the repository is broken, which is
 * when it is most needed.
 *
 * `scripts/lanes.ts` carries a typed twin of this matcher. Two implementations of one rule
 * is a drift risk, so `pnpm check:lanes` asserts they agree on a table of cases rather than
 * trusting that they do.
 *
 * `**` crosses directory separators, `*` and `?` do not.
 */

/**
 * @param {string} path
 * @param {string} pattern
 * @returns {boolean}
 */
export function matchPath(path, pattern) {
  const p = normalise(path);
  const src = normalise(pattern)
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === '**/') return '(?:.*/)?';
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      if (part === '?') return '[^/]';
      return part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${src}$`).test(p);
}

/**
 * @param {string} path
 * @param {string[]} patterns
 * @returns {string|null} the pattern that matched, so a refusal can name its rule
 */
export function anyMatch(path, patterns) {
  return patterns.find((pattern) => matchPath(path, pattern)) ?? null;
}

/** @param {string} p */
export function normalise(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}
