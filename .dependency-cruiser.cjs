/**
 * Architectural boundary enforcement (MVP_PLAN.md §17, corrections doc §10).
 *
 * v1 of the plan assigned this to an LLM agent. That contradicted the plan's own rule
 * about preferring deterministic tooling for mechanical validation, so it is tooling now.
 * Reviewer does not check imports; this file does, and it is better at it.
 *
 * `tsPreCompilationDeps` is on deliberately. A type-only import is erased at runtime but
 * is still architectural coupling — `playground` knowing the shape of an API DTO is a
 * boundary violation whether or not a `require` survives compilation.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'platform-not-to-playground',
      severity: 'error',
      comment:
        'Platform must run correctly with playground/ deleted. This is the boundary the ' +
        'whole architecture story rests on, and check:isolation proves it end to end.',
      from: { path: '^platform/' },
      to: { path: '^playground/' },
    },
    {
      name: 'platform-not-to-claude',
      severity: 'error',
      comment:
        '.claude/ is engineering infrastructure. Engineering Agents must never become ' +
        'runtime dependencies — LenGentic must run with .claude/ deleted.',
      from: { path: '^platform/' },
      to: { path: '^\\.claude/' },
    },
    {
      name: 'playground-not-to-claude',
      severity: 'error',
      comment: 'Playground Runtime must not reach Engineering Agents.',
      from: { path: '^playground/' },
      to: { path: '^\\.claude/' },
    },
    {
      name: 'playground-not-to-api',
      severity: 'error',
      comment:
        'Playground talks to the Platform over HTTP through the SDK. Importing the API ' +
        'directly would make the Playground a false consumer that proves nothing about ' +
        'the wire contract.',
      from: { path: '^playground/' },
      to: { path: '^platform/api/' },
    },
    {
      name: 'playground-not-to-analysis-engine',
      severity: 'error',
      comment:
        'Analysis is a Platform concern. A Playground that could import the analyzer ' +
        'could shape its telemetry to satisfy it.',
      from: { path: '^playground/' },
      to: { path: '^platform/analysis-engine/' },
    },
    {
      name: 'playground-sdk-public-entry-only',
      severity: 'error',
      comment:
        'Playground may use platform/telemetry-sdk, but only through its public entry. ' +
        'Deep imports into src/ make internals part of the contract by accident.',
      from: { path: '^playground/' },
      to: { path: '^platform/telemetry-sdk/src/(?!index\\.ts$)' },
    },
    {
      name: 'playground-not-to-other-platform-packages',
      severity: 'error',
      comment:
        'telemetry-sdk is the only Platform package the Playground may consume ' +
        '(MVP_PLAN.md §17).',
      from: { path: '^playground/' },
      to: { path: '^platform/(?!telemetry-sdk/)' },
    },
    {
      name: 'sdk-depends-on-shared-only',
      severity: 'error',
      comment:
        'The SDK is the public artifact. A transitive Prisma or Nest dependency would ' +
        'make every consumer install a database client to emit telemetry (corrections §10).',
      from: { path: '^platform/telemetry-sdk/' },
      to: { path: '^platform/(?!telemetry-sdk/|shared/)' },
    },
    {
      name: 'analysis-engine-is-pure',
      severity: 'error',
      comment:
        'The analysis engine is pure functions over decision records (MVP_PLAN_V3.md §18-20). ' +
        'It owns no persistence, no transport and no rendering, so it may not reach the ' +
        'database, the API, the Dashboard or the Playground. The Zod schema and the explicit ' +
        'mapper that carry its output across a process boundary land in 5b, on the far side ' +
        'of that boundary — never inside the engine.',
      from: { path: '^platform/analysis-engine/' },
      to: { path: '^(platform/(api|database|dashboard)|playground)/' },
    },
    {
      name: 'nothing-to-spike',
      severity: 'error',
      comment:
        'spike/ is disposable and is deleted at the end of Phase 5. Anything importing ' +
        'it would break on that deletion.',
      from: { path: '^(platform|playground)/' },
      to: { path: '^spike/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'A dependency cycle is a module boundary that was never really drawn.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment:
        'Production code depending on a devDependency builds locally and fails in the ' +
        'Docker image, where devDependencies are pruned.',
      from: { path: '^(platform|playground)/', pathNot: '\\.(test|spec)\\.ts$' },
      to: { dependencyTypes: ['npm-dev'] },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|dist|build|\\.next|coverage|generated)(/|$)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
