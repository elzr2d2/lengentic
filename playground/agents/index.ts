/**
 * Public entry for `playground/agents`. The CLI (Phase 3 work package 6) and any test
 * import `MockAgent` from here rather than reaching into `mock-agent.ts` directly — the
 * same one-entry-per-directory idiom `playground/index.ts`, `playground/providers`,
 * `playground/determinism` and `playground/strategy` each already set.
 */
export { MockAgent, MockAgentConfigError } from './mock-agent';
export type {
  MockAgentConfig,
  MockAgentRunResult,
  MockAgentTaskConfig,
  MockAgentTaskResult,
} from './mock-agent';
