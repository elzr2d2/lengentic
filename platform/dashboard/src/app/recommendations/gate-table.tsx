import type { GateId, GateResult, GateResults, GateStatus } from '@lengentic/shared';
import { gateLabel } from './format';

/**
 * §19's Gates block, rendered — **every** gate, by name, whatever the verdict.
 *
 * §19 spends a paragraph on why this is a table rather than a headline: "Suppressed by G2"
 * when it also fails G4 understates the problem, and an engineer who fixes only context
 * diversity returns to find it still suppressed. `GateResultsSchema` already guarantees five
 * entries in `GATE_IDS` order, so this component renders the array it is given and neither
 * filters nor re-sorts it — a filter here would be the understatement §19 forbids, reinserted
 * one layer below the contract that removed it.
 *
 * `comparison` is evidence for a reader, never an assertion target: the schema says formatting
 * is not part of the contract, so this prints the string and parses nothing out of it.
 */
export function GateTable({ gates }: { gates: GateResults }) {
  return (
    <ul className="gate-list">
      {gates.map((gate) => (
        <GateRow key={gate.id} gate={gate} />
      ))}
    </ul>
  );
}

function GateRow({ gate }: { gate: GateResult }) {
  return (
    <li className="gate-row">
      <span className="gate-name">{gateLabel(gate.id)}</span>
      <span className={`status ${statusClass(gate.status)}`}>{gate.status}</span>
      <span className="gate-comparison">({gate.comparison})</span>
    </li>
  );
}

/**
 * NOT_APPLICABLE is `status-warn`, not `status-ok`. A gate that could not be evaluated has not
 * been passed, and colouring it green would read as evidence it never produced.
 */
function statusClass(status: GateStatus): string {
  switch (status) {
    case 'PASS':
      return 'status-ok';
    case 'FAIL':
      return 'status-down';
    case 'NOT_APPLICABLE':
      return 'status-warn';
  }
}

/**
 * The failing gates as one line — `G2 context_diversity, G4 outcome_success`.
 *
 * Takes `failedGates` rather than deriving it from `gates`: the schema already refines the
 * two against each other on every parse, so deriving here would be a second implementation of
 * a rule that is already enforced, and the two could disagree.
 */
export function FailedGateList({ failedGates }: { failedGates: readonly GateId[] }) {
  return <span className="value">{failedGates.map(gateLabel).join(', ')}</span>;
}
