/**
 * The progression invariant — the one place that decides whether a gate may be recorded and
 * a phase may advance.
 *
 * `autopilot` §3 states the rule in prose: GREEN is four sources that must agree, and any one
 * alone is a green that lies. This file is that rule as a total function, so that a session
 * cannot re-derive it more generously under pressure, and so the false-green cases have
 * somewhere to be regression-tested.
 *
 * Two properties are load-bearing and are asserted by `pnpm check:autopilot`:
 *
 *   1. **UNKNOWN is RED.** `CLAUDE.md` ## Dispatch already says unknown counts as false. A
 *      source nobody measured has not passed; a supervisor is exactly the actor that would
 *      otherwise treat "no evidence either way" as consent.
 *
 *   2. **No single source may imply completion.** 11/11 nodes with a red gate is HOLD_PHASE,
 *      never ADVANCE_PHASE. That is not a hypothetical: a phase in this repository once sat
 *      at `pnpm gates:full` exit 0 with two unbound Definition-of-Done checkboxes and was RED
 *      (`CLAUDE.md` ## Current state).
 *
 * Claude is not one of the sources. A worker reporting DONE moves `nodes` no further than
 * "the probes may now pass" — the probes are then re-run by the oracle, and it is the oracle's
 * answer that lands here.
 */

export type SourceVerdict = 'GREEN' | 'RED' | 'UNKNOWN';

export interface Source {
  verdict: SourceVerdict;
  /** How this verdict was established — a command, a probe, a validated artifact. */
  derivedFrom: string;
  /** Artifact paths. A GREEN source with no evidence path is reported as unevidenced. */
  evidence: string[];
}

/**
 * The mandatory sources for a PHASE gate, in the order `autopilot` §3 lists them, plus the
 * artifact-presence row the plan's Definition of Done depends on.
 */
export const PHASE_SOURCES = [
  'nodes',
  'gates',
  'definitionOfDone',
  'artifacts',
  'failureEvidence',
] as const;

/**
 * A WAVE gate is narrower by design: the Definition of Done is a phase-level contract and is
 * not re-adjudicated per wave. The wave gate proves the deterministic gates are green over the
 * combined diff, that the wave's required validation ran, and that no `this-node` red is still
 * unexplained.
 */
export const WAVE_SOURCES = ['nodes', 'gates', 'validation', 'failureEvidence'] as const;

export type PhaseSourceName = (typeof PHASE_SOURCES)[number];
export type WaveSourceName = (typeof WAVE_SOURCES)[number];

export type Sources = Partial<Record<PhaseSourceName | WaveSourceName, Source>>;

export interface Blocker {
  source: string;
  verdict: SourceVerdict;
  why: string;
}

export interface Verdict {
  /** ADVANCE for a phase gate, RECORD for a wave gate; HOLD for either. */
  verdict: 'ADVANCE_PHASE' | 'RECORD_WAVE' | 'HOLD_PHASE' | 'HOLD_WAVE';
  gate: 'wave' | 'phase';
  green: boolean;
  blockers: Blocker[];
  /** Every evidence path the GREEN sources cited, deduplicated — what the record points at. */
  evidence: string[];
}

function judge(gate: 'wave' | 'phase', required: readonly string[], sources: Sources): Verdict {
  const blockers: Blocker[] = [];
  const evidence: string[] = [];

  for (const name of required) {
    const source = sources[name as PhaseSourceName];
    if (source === undefined) {
      blockers.push({
        source: name,
        verdict: 'UNKNOWN',
        why: 'mandatory source was never measured — unknown is not green',
      });
      continue;
    }
    if (source.verdict === 'GREEN') {
      if (source.evidence.length === 0) {
        blockers.push({
          source: name,
          verdict: 'GREEN',
          why: `GREEN with no evidence path (${source.derivedFrom}) — a record points at proof`,
        });
        continue;
      }
      evidence.push(...source.evidence);
      continue;
    }
    blockers.push({
      source: name,
      verdict: source.verdict,
      why:
        source.verdict === 'RED'
          ? `RED per ${source.derivedFrom}`
          : `UNKNOWN per ${source.derivedFrom} — unknown counts as false`,
    });
  }

  const green = blockers.length === 0;
  return {
    gate,
    green,
    verdict: green
      ? gate === 'phase'
        ? 'ADVANCE_PHASE'
        : 'RECORD_WAVE'
      : gate === 'phase'
        ? 'HOLD_PHASE'
        : 'HOLD_WAVE',
    blockers,
    evidence: [...new Set(evidence)],
  };
}

/** Whether this phase may be gated GREEN and the run may advance past it. */
export function phaseVerdict(sources: Sources): Verdict {
  return judge('phase', PHASE_SOURCES, sources);
}

/** Whether this wave's gate record may be written. */
export function waveVerdict(sources: Sources): Verdict {
  return judge('wave', WAVE_SOURCES, sources);
}

export function green(derivedFrom: string, evidence: string[]): Source {
  return { verdict: 'GREEN', derivedFrom, evidence };
}

export function red(derivedFrom: string, evidence: string[] = []): Source {
  return { verdict: 'RED', derivedFrom, evidence };
}

export function unknown(derivedFrom: string): Source {
  return { verdict: 'UNKNOWN', derivedFrom, evidence: [] };
}

/** One line per source, for the console and for the evidence artifact. Same text in both. */
export function renderVerdict(v: Verdict, sources: Sources): string[] {
  const required = v.gate === 'phase' ? PHASE_SOURCES : WAVE_SOURCES;
  const lines = required.map((name) => {
    const s = sources[name as PhaseSourceName];
    const verdict = s?.verdict ?? 'UNKNOWN';
    const from = s?.derivedFrom ?? 'never measured';
    return `  ${verdict.padEnd(7)} ${name.padEnd(18)} ${from}`;
  });
  lines.push('', `  => ${v.verdict}`);
  for (const b of v.blockers) lines.push(`     blocked by ${b.source}: ${b.why}`);
  return lines;
}
