---
name: report-handoff
description: Return a handoff another agent can act on — which contract, what belongs in an artifact instead of the message, and what evidence DONE requires. Use before returning any finding, verdict, or completion claim.
---

# Report Handoff

Your last message is the deliverable. Everything else you did this session is gone, and the
receiver acts on what is in front of them.

## Which contract

| You are reporting                   | Contract                                 | Checked by                                         |
| ----------------------------------- | ---------------------------------------- | -------------------------------------------------- |
| a finding about someone else's work | `.claude/rules/handoff.schema.json`      | `.claude/hooks/validate-handoff.mjs`, SubagentStop |
| your own lane's work                | `.claude/rules/lane-handoff.schema.json` | `pnpm lanes handoff <file>`                        |

One JSON object, the fields the schema names, nothing wrapped around it. Not the task
restated, not a tour of how you got there, not a closing summary of the object above it.

State facts. "Ran the gates; exit 0" is a fact; "I then went ahead and carefully verified the
gates" is the same fact wearing a paragraph.

## Detail lives in an artifact

Write full output under `.artifacts/` — the ownership hook allows that path from inside any
lane — and put the path in `artifacts`. The report carries the decisive line: the failing
assertion, the exit code, the diff between expected and actual. The artifact carries the run.

Concision applies to what you add, never to what you observed. Trimming a stack trace to
"tests fail" is not concision, it is deletion. Move it, cite it, keep it whole.

`runner` is the exception: raw capture is its product. It may redirect into
`.artifacts/runs/**` and cite the path, and it reports verbatim either way.

## Evidence, per requirement

A command that passed is evidence for the requirement it exercised, and for nothing else.
Each entry answers all five:

```yaml
requirement: # the acceptance criterion, verbatim from the packet
expected: # with its source — the DoD line, the contract, the worked example
actual: # what you observed, the decisive line
verification: # the command, the request, the file:line, the second interface
result: # PASS | FAIL | UNKNOWN
artifact: # where the full output lives
```

`UNKNOWN` is the honest result for a check that ran but did not settle the criterion. It is
not a pass, and it keeps the lane out of `DONE`. Deferred, skipped and not-run are all
`unverified` — there is no third bucket.

Counts are derived, never restated: the requirement totals come from `evidence`, the test
totals from `tests`. A summary that disagrees with the arrays it summarises is a second
source of truth, and the checker rejects it.

## What `DONE` costs

`pnpm lanes handoff` refuses `DONE` when:

- a criterion in `acceptance_criteria.verified` has no `evidence` entry, or its evidence is
  `FAIL` or `UNKNOWN`
- any validation result did not pass, or `passed` disagrees with the exit code
- the results do not line up one-to-one with the commands that produced them
- a failing command appears in no `failures` entry — an unclassified failure
- reruns of one command disagree; a second green does not erase a first red
- a test command ran and `tests` is missing, `discovered` is zero, or `failed` is above zero
- `failures` is non-empty and no `artifacts` path holds the captured output

Green is not the claim. The claim is that the thing asked for works, and a suite that
discovered nothing passes perfectly. Run `pnpm gates` before you report — the deterministic
checks cost nothing and catch most of this first.

## What each role owns

Report your own evidence. Repeating evidence another role already produced inflates the
handoff and creates a second copy to disagree with the first.

| Role            | Its minimum, in schema fields                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `architect`     | the decision and its rejected alternatives in `recommendedNextAction`; open questions in `unknowns`               |
| `builder`       | `changed_files`, `evidence` per acceptance criterion, `validation` from gates it ran itself                       |
| `runner`        | `evidence[].verification` and `actual` per command, with exit codes; `artifacts` paths; no verdict on the product |
| `tester`        | `failure`, `evidence` with expected's source cited, and the classification                                        |
| `reviewer`      | findings in `failure` and `evidence`, ranked per axis; residual risk in `unknowns`                                |
| `watchdog`      | every `check:integrity` category including the clean ones, each hit confirmed or unconfirmed, at `file:line`      |
| `diagnostician` | exactly one classification, the reproduction rate, and what was eliminated                                        |
| `reflector`     | the seven fields its role file names, `owner: human`                                                              |

`owner` is who acts next, and never the reporting role.
