---
title: Matt Pocock / AI Hero — AI engineering method for coding agents
source: https://www.aihero.dev/ and https://github.com/mattpocock/skills
researched: 2026-08-16
review-by: 2026-11-14
status: current
---

# Matt Pocock / AI Hero — AI Engineering Knowledge Base

**Document version:** 1.0
**Research date:** 2026-08-16
**Primary scope:** Public material published by Matt Pocock on AI Hero and the open-source `mattpocock/skills` repository.
**Purpose:** A compact, reusable source for designing prompts, coding-agent workflows, skills, context management, validation, and autonomous execution.

> This is a synthesis, not a mirror of AI Hero and not a substitute for Matt's paid material. It covers the relevant public doctrine available on the research date.

---

## ⚠ Provenance warning — read before citing this note

**Sections §4.5, §11.1 and §15 are LenGentic-derived, not reported from AI Hero.** Each
says so in its own text:

- §4.5 — "This contract is a LenGentic extension, consistent with Matt's principles but not copied from a named Matt skill."
- §11.1 — "This schema is a LenGentic extension built from Matt's fresh-context, bounded-loop, progress-file, feedback-loop, and completion-criteria principles."
- §15 — "This section is an El/LenGentic synthesis, not a direct Matt quotation."

Those three sections are this repository's own doctrine written down in this document.
**They are not independent corroboration.** Do not cite them as external evidence for a
decision LenGentic already made — that is circular. Everything else in this note is
reported from the public sources listed in §17.

Reviewed against the harness on 2026-08-16; findings in
`.artifacts/reports/matt-pocock-kb-review-2026-08-16.md`.

Per §18 of this document, revalidate the numeric and model-specific claims (context sizes,
the smart-zone thresholds, the skill catalogue version) before relying on them after
`review-by`.

---

## 1. The model in one page

Matt's central claim is not that prompts replace engineering. It is the opposite: agents make engineering discipline more valuable because they accelerate both delivery and entropy.

The operating model:

1. Clarify the idea before code.
2. Research only what is externally uncertain.
3. Prototype questions whose answer needs running code.
4. Record the destination in a spec.
5. Split multi-session work into small, independently verifiable vertical slices.
6. Execute each slice in a fresh context with tight feedback loops.
7. Review the result independently against both the spec and repository standards.

The permanent assets are not chat transcripts. They are:

- shared domain vocabulary;
- architectural decision records;
- specs and tickets;
- code, tests, and commits;
- explicit verification evidence.

The agent is best treated like a capable new engineer with no durable memory. Give it clear interfaces, fast feedback, scoped work, and only the context needed now. The codebase influences output more than clever prompt wording. [AI Hero homepage](https://www.aihero.dev/) · [How to make codebases AI agents love](https://www.aihero.dev/how-to-make-codebases-ai-agents-love)

---

## 2. Core doctrine

### 2.1 Engineering fundamentals compound

- Faster code generation also creates faster architectural decay.
- Types, tests, browser/runtime validation, good module boundaries, and review remain the control system.
- A prompt cannot compensate reliably for a codebase that is hard to navigate or verify.
- The objective is trustworthy shipped behavior, not maximum generated code.

Source: [Skills for Real Engineers](https://github.com/mattpocock/skills) · [AI Hero](https://www.aihero.dev/)

### 2.2 Alignment precedes implementation

The most common failure is not syntax. It is building the wrong thing because the human and agent hold different models.

Operational rule:

- If the destination is fuzzy, grill the idea.
- Ask in rounds, wait for answers, expose assumptions and branches.
- Stop when consequential decisions are resolved; do not plan low-fidelity details indefinitely.
- Preserve valuable decisions before leaving the context.

Source: [`grill-with-docs`](https://www.aihero.dev/skills-grill-with-docs) · [Common grilling mistakes](https://www.aihero.dev/things-people-get-wrong-with-grill-me-and-grill-with-docs)

### 2.3 Shared language is context compression

Resolve project-specific terms once and use them consistently in conversation, code, tests, files, and tickets.

- Stable term → `CONTEXT.md`.
- Hard-to-reverse, surprising trade-off → ADR.
- Routine choice → conversation/spec; do not turn everything into permanent documentation.

Benefits:

- fewer words per session;
- consistent naming;
- easier navigation;
- less repeated inference;
- better human-agent alignment.

Source: [`grill-with-docs`](https://www.aihero.dev/skills-grill-with-docs) · [Skills repository](https://github.com/mattpocock/skills)

### 2.4 Feedback rate is the speed limit

Agents need executable feedback, not reassurance.

Preferred signals:

- typecheck;
- focused test file;
- full suite at the end;
- lint/static analysis;
- browser or API assertion;
- deterministic repro command;
- observable runtime output.

If the agent cannot observe whether a change worked, it is flying blind.

Source: [Skills repository](https://github.com/mattpocock/skills) · [`diagnosing-bugs`](https://www.aihero.dev/skills-diagnosing-bugs)

### 2.5 Small, complete slices beat large phases

A good implementation unit is a tracer bullet: one narrow path through all required layers that works and can be demonstrated alone.

- Prefer schema + API + UI + test for one behavior.
- Avoid "all schema, then all APIs, then all UI."
- Each ticket should fit one fresh context window.
- Declare blocking edges explicitly.
- Use expand→migrate→contract for wide refactors that cannot remain green as vertical slices.

Source: [`to-tickets`](https://www.aihero.dev/skills-to-tickets)

---

## 3. Context engineering

### 3.1 Smart zone / dumb zone

Matt describes session quality as degrading gradually as context grows. The model may remain technically within its context limit while already becoming forgetful, repetitive, or contradictory.

Signals of degradation:

- re-asking answered questions;
- forgetting earlier constraints;
- repeating a corrected mistake;
- confidently contradicting context;
- declining quality late in a long task.

Rules:

- Plan around the high-quality "smart zone," not the advertised maximum window.
- Prefer one task per session.
- Split work that cannot fit one smart zone.
- When attention degrades, remove context; adding another explanation often adds more noise.
- Use a fresh session at natural boundaries.

The exact token threshold is heuristic and model-dependent, not a reliable invariant. Matt's public writing gives rough figures, but the behavioral signals are more useful than a fixed number.

Source: [Smart zone](https://www.aihero.dev/ai-coding-dictionary/smart-zone) · [Attention degradation](https://www.aihero.dev/ai-coding-dictionary/attention-degradation)

### 3.2 Continue, compact, clear, or hand off

| Move     | Preserve                 | Use when                                                   |
| -------- | ------------------------ | ---------------------------------------------------------- |
| Continue | Primary conversation     | Context is still healthy and current reasoning is valuable |
| Compact  | Intent through a summary | Same task and environment, but a fresh window is needed    |
| Clear    | Nothing                  | Prior context is disposable                                |
| Handoff  | Portable summary file    | Work moves to another agent, harness, or environment       |

All summaries are secondary sources. Prefer the original conversation while it remains usable. Do not create a handoff merely to keep working in the same place.

Source: [`handoff`](https://www.aihero.dev/skills-handoff)

### 3.3 Context load vs cognitive load

- **Context load:** tokens automatically paid by the agent every turn.
- **Cognitive load:** the human's burden of knowing which document/skill to invoke.

Matt deliberately accepts some human cognitive load to reduce unconditional context load. The human is the index; precise pointers disclose details only when needed.

Source: [`writing-for-agents`](https://www.aihero.dev/skills-writing-for-agents)

### 3.4 Minimal `AGENTS.md` / `CLAUDE.md`

Keep always-loaded instructions extremely small:

- one-sentence project description;
- non-default package manager;
- non-standard build/typecheck commands;
- only rules relevant to virtually every task.

Move language rules, testing rules, architecture, and domain guidance behind precise links or skills. Prefer stable capabilities and domain concepts over brittle file-path descriptions. In monorepos, scope instructions to the package where they apply.

Source: [Complete guide to AGENTS.md](https://www.aihero.dev/a-complete-guide-to-agents-md)

---

## 4. Writing for agents

The goal is repeatable behavior, not literary completeness.

### 4.1 The no-op test

For every sentence, ask: if deleted, would agent behavior materially change?

- If no, delete it.
- If instructions duplicate another source, choose one source of truth.
- Do not shorten useful behavior into ambiguity; delete no-ops rather than merely compressing wording.
- Avoid explaining knowledge the model already has.

### 4.2 Progressive disclosure

Use an information ladder:

1. current step;
2. short in-file reference;
3. external document behind a context pointer;
4. specialized skill loaded only when relevant.

The pointer must encode both what the resource contains and when it should be read.

### 4.3 Leading words

Use compact concepts already grounded in software practice:

- tight loop;
- red/green;
- tracer bullet;
- public seam;
- primary source;
- fixed point;
- expand→contract.

These words carry a process more efficiently than long bespoke explanations.

### 4.4 Completion criteria

Every operational instruction should make "done" observable. Completion criteria force the legwork that prevents premature green status.

Good criteria identify:

- command run;
- expected exit/result;
- artifact or diff inspected;
- scope covered;
- conditions that block completion;
- exact terminal status/sentinel if orchestration consumes the result.

Source: [`writing-for-agents`](https://www.aihero.dev/skills-writing-for-agents) · [Plan mode](https://www.aihero.dev/plan-mode-introduction)

### 4.5 El/LenGentic adaptation — evidence-backed completion

> **DERIVED SECTION.** Not reported from AI Hero. See the provenance warning above.

Matt emphasizes completion criteria, citations, feedback loops, and reproducible commands. For LenGentic, strengthen that into a formal outcome contract:

```text
STATUS: DONE | BLOCKED | FAILED
CLAIM: <what changed>
EVIDENCE:
- <command or probe> -> <observed result>
- <artifact/diff/log> -> <relevant locator>
UNVERIFIED:
- <anything not directly checked>
```

Rules:

- A success-colored log is not evidence.
- A sub-agent summary is a hypothesis until checked against the cited artifact.
- "Tests passed" must name the executed command and result.
- Deferred, skipped, unavailable, and not run must never collapse into passed.

This contract is a LenGentic extension, consistent with Matt's principles but not copied from a named Matt skill.

---

## 5. Idea-to-ship workflow

### 5.1 Decision tree

| Situation                                  | Minimum useful path                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| Small, already-decided change              | Implement directly, then independent review                               |
| Fuzzy single-session change in a repo      | `grill-with-docs` → implement → review                                    |
| Decided multi-session feature              | `to-spec` → `to-tickets` → one implementation session per ticket → review |
| Large, unclear effort                      | `wayfinder` → resolve decision map → spec → tickets → implementation      |
| External uncertainty                       | Research, then feed the cited artifact into planning                      |
| Design question answerable by running code | Throwaway prototype, retain the decision rather than the prototype        |
| Known hard bug                             | Build a deterministic repro before forming theories                       |

### 5.2 The seven phases

1. **Idea:** refine the desired outcome.
2. **Research, optional:** investigate external uncertainty and cache short-lived facts.
3. **Prototype:** use disposable code to answer a design question or express taste.
4. **Spec:** document the destination and observable behavior, not the implementation journey.
5. **Tickets:** split into agent-sized tracer bullets with blocking edges.
6. **Execution:** build one slice at a time with tests/types/runtime feedback.
7. **QA/review:** compare the implementation to both intended behavior and engineering standards.

Source: [Seven phases of AI development](https://www.aihero.dev/my-7-phases-of-ai-development)

### 5.3 Main skill flow

```text
grill-with-docs -> to-spec -> to-tickets -> implement -> code-review
```

This is not mandatory ceremony. Skip spec/tickets when the work safely fits one context. Add research/prototype only when they resolve a real unknown.

Source: [AI Hero skills catalogue](https://www.aihero.dev/skills)

---

## 6. Artifact contracts

| Artifact              | Role                                        | Lifetime              | Failure mode                                        |
| --------------------- | ------------------------------------------- | --------------------- | --------------------------------------------------- |
| `CONTEXT.md`          | Shared domain vocabulary                    | Durable, maintained   | Bloated glossary or stale terms                     |
| ADR                   | Consequential trade-off and rationale       | Durable               | Recording routine choices as architecture           |
| Research note         | Current external facts with citations       | Sprint/feature        | Stale note poisoning later context                  |
| Prototype             | Resolve one uncertainty                     | Disposable            | Prototype quietly becoming production architecture  |
| Spec                  | Agreed destination, behavior, seams         | Feature lifetime      | Inventing new decisions while "summarizing"         |
| Ticket                | One independently verifiable vertical slice | Until shipped         | Horizontal layers, hidden blockers, oversized scope |
| Progress file         | Cross-session working state                 | During autonomous run | Becoming a duplicate source of truth                |
| Commit/diff           | Auditable implemented change                | Durable               | Reviewing uncommitted or wrong-range work           |
| Verification evidence | Proof of outcome                            | With run/result       | Green summary without attestation                   |

Research is not automatically reused merely because it exists. A later task or pointer must explicitly load it. Archive/delete stale research; keep durable decisions as ADRs.

Source: [`research`](https://www.aihero.dev/skills-research) · [`grill-with-docs`](https://www.aihero.dev/skills-grill-with-docs)

---

## 7. TDD and testing

### 7.1 Pre-agreed seams

Testing effort is finite. Agree the public boundary before writing tests. Test observable behavior through that seam, not internal implementation details.

Good seams include:

- public function/module API;
- request/response contract;
- user-visible behavior;
- durable integration boundary.

### 7.2 Loop

1. Write one failing test for one behavior.
2. Run it and observe red.
3. Implement only enough to make it green.
4. Repeat with the next behavior.
5. Typecheck and run focused tests frequently.
6. Run the full suite once near the end.
7. Refactor/review in a separate pass when independent judgment is valuable.

### 7.3 Anti-patterns

- **Implementation-coupled:** internal rename breaks the test while behavior is unchanged.
- **Tautological:** expected output is calculated using the same logic as production.
- **Horizontal test batch:** all imagined tests are written before any working vertical slice.
- **Internal mocking:** mocks encode collaborators owned by the same codebase rather than system boundaries.
- **False seam:** a convenient test point that cannot exercise the real failure pattern.

Mocks belong mainly at external APIs, time, randomness, and other true system boundaries.

Source: [`tdd`](https://www.aihero.dev/skills-tdd)

---

## 8. Diagnosis before fixing

For a hard defect or regression:

1. **Reproduce:** create one named command that goes red on the exact symptom.
2. **Minimize:** remove every element that is not load-bearing.
3. **Hypothesize:** rank 3-5 falsifiable hypotheses and state predictions.
4. **Instrument:** probe one variable at a time; tag temporary logs for guaranteed cleanup.
5. **Fix:** write the regression test before the fix if a valid seam exists.
6. **Clean:** remove instrumentation, rerun the original repro, record the confirmed cause.

Preferred repro mechanisms, in rough order:

- failing test;
- HTTP/curl script;
- CLI fixture and known-good snapshot;
- headless browser assertion;
- saved request/event replay;
- minimal harness;
- property/fuzz loop;
- bisection or differential harness;
- human-in-the-loop script only as a last resort.

A useful loop is fast, deterministic, sharp, and agent-runnable. If no red-capable loop exists, stop and request the missing access/artifact instead of guessing.

Source: [`diagnosing-bugs`](https://www.aihero.dev/skills-diagnosing-bugs)

---

## 9. Architecture for agents

The target is deep modules: substantial behavior behind a small, intentional interface.

Matt's "grey box" division of responsibility:

- Human owns the interface, constraints, and taste.
- Agent can own much of the implementation.
- Tests enforce the public contract.

Characteristics:

- file/module boundaries match the project's mental model;
- few high-cohesion interfaces instead of many shallow, mutually coupled modules;
- behavior is testable without reaching inside;
- a fresh agent can navigate by domain concepts;
- feedback is fast enough to steer implementation.

Architecture improvement is continuous upkeep, not a rescue performed only after the codebase becomes mud.

Source: [How to make codebases AI agents love](https://www.aihero.dev/how-to-make-codebases-ai-agents-love) · [`improve-codebase-architecture`](https://www.aihero.dev/skills-improve-codebase-architecture)

---

## 10. Review and evidence

### 10.1 Two independent axes

| Axis      | Question                   | Primary source                                      |
| --------- | -------------------------- | --------------------------------------------------- |
| Standards | Was it built right?        | Repository standards plus explicit smell heuristics |
| Spec      | Was the right thing built? | Originating spec/ticket                             |

Keep verdicts separate. Passing one axis must not hide failure on the other.

### 10.2 Independent context

- Prefer review from a fresh session.
- Separate author assumptions from reviewer judgment.
- Use a fixed, verified diff range.
- Review per ticket for precision and once at branch end for interactions when risk warrants both.

### 10.3 Findings are leads, not truth

- Require a cited rule/spec line and relevant diff hunk.
- Verify the cited location before acting.
- Do not loop review until "clean"; judgment-based review has no convergence guarantee.
- A missing spec should produce "no spec available," not inferred requirements.

Source: [`code-review`](https://www.aihero.dev/skills-code-review)

---

## 11. Autonomous execution / Ralph

Ralph is a deliberately simple outer loop:

1. Start a fresh agent context.
2. Read the PRD and progress state.
3. Select one highest-priority incomplete task.
4. Implement one task only.
5. Run feedback loops.
6. Update progress.
7. Commit.
8. Exit; begin the next iteration with another fresh context.

Controls:

- Start human-in-the-loop; move AFK only after observing behavior.
- Define scope and quality explicitly.
- Prioritize risky work early.
- Cap iterations and cost.
- Isolate AFK execution in a sandbox/container.
- Keep task state outside the conversation.
- Use a machine-readable completion sentinel.
- Do not keep every loop iteration inside one ever-growing session.

The fresh context is a core feature, not an implementation detail. It prevents accumulated session cruft from moving the agent into degraded attention.

Source: [Getting started with Ralph](https://www.aihero.dev/getting-started-with-ralph) · [11 Ralph tips](https://www.aihero.dev/tips-for-ai-coding-with-ralph-wiggum) · [Why one-session Ralph degrades](https://www.aihero.dev/why-the-anthropic-ralph-plugin-sucks)

### 11.1 El/LenGentic adaptation — bounded autonomous run contract

> **DERIVED SECTION.** Not reported from AI Hero. See the provenance warning above.
> Note this schema is LenGentic's own product model pointed at LenGentic's own harness.

Each iteration should persist:

```text
runId
workflowVersion
contextKey
ticketId
parentEvidenceIds[]
commandsExecuted[]
artifactsChanged[]
verificationResults[]
tokenCost
elapsedMs
status
blockedReason?
```

The orchestrator should stop on:

- failed required feedback loop;
- missing outcome attestation;
- context degradation signal;
- retry/cost/time budget reached;
- ambiguous destructive action;
- recursive/unbounded delegation.

This schema is a LenGentic extension built from Matt's fresh-context, bounded-loop, progress-file, feedback-loop, and completion-criteria principles.

---

## 12. Multi-agent guidance

Matt's public skill set uses agents for isolation, not for maximal fan-out.

Good uses:

- independent Standards and Spec reviews;
- background primary-source research while keeping the main context clean;
- one fresh implementation session per ticket;
- separate review from authorship.

Controls:

- Give each agent one bounded output and explicit stop condition.
- Forbid sub-agents from recursively invoking the same delegation skill.
- Treat sub-agent conclusions as hypotheses until primary evidence is checked.
- Do not delegate the human's product decision; delegate legwork.
- Parallelize only independent work with non-overlapping ownership or explicit integration gates.

Known public rough edges include recursive research/review fan-out and review visibility of uncommitted changes. These are warnings to add structural guards, not patterns to copy. [`research`](https://www.aihero.dev/skills-research) · [`code-review`](https://www.aihero.dev/skills-code-review) · [`implement`](https://www.aihero.dev/skills-implement)

---

## 13. Skills map (public v1.2-era catalogue)

### Getting started

| Skill                      | Purpose                                                      |
| -------------------------- | ------------------------------------------------------------ |
| `setup-matt-pocock-skills` | Configure tracker, labels, and domain-doc locations per repo |
| `ask-matt`                 | Route a situation to the smallest useful skill/flow          |

### Main flow

| Skill             | Purpose                                                    |
| ----------------- | ---------------------------------------------------------- |
| `grill-with-docs` | Align on a plan; persist terms and consequential decisions |
| `to-spec`         | Turn already-decided conversation into a destination/spec  |
| `to-tickets`      | Split work into tracer bullets and blocking edges          |
| `implement`       | Build one spec/ticket test-first with feedback loops       |
| `code-review`     | Review diff separately against Standards and Spec          |

### Shaping

| Skill       | Purpose                                                  |
| ----------- | -------------------------------------------------------- |
| `wayfinder` | Map and resolve a multi-session decision space           |
| `prototype` | Answer a design question with code intended for deletion |
| `research`  | Produce a cited answer from primary sources              |

### Upkeep

| Skill                           | Purpose                                             |
| ------------------------------- | --------------------------------------------------- |
| `improve-codebase-architecture` | Find deep-module refactoring opportunities          |
| `diagnosing-bugs`               | Gate diagnosis behind a tight red/green repro       |
| `resolving-merge-conflicts`     | Resolve each hunk by tracing intent to both sources |
| `triage`                        | Convert raw incoming issues into ready work         |
| `wizard`                        | Generate a human-operated setup/cutover script      |

### Productivity

| Skill                | Purpose                                             |
| -------------------- | --------------------------------------------------- |
| `grill-me`           | Align on any idea outside a repository              |
| `handoff`            | Create a portable continuation summary              |
| `to-questionnaire`   | Capture decisions that must come from another human |
| `teach`              | Stateful learning across sessions                   |
| `wait-what`          | Re-explain from the point comprehension failed      |
| `writing-for-agents` | Design agent-readable instructions and documents    |

### Reference disciplines

| Skill             | Purpose                                               |
| ----------------- | ----------------------------------------------------- |
| `codebase-design` | Vocabulary and rules for deep modules and clean seams |
| `domain-modeling` | Maintain shared language and ADRs                     |
| `grilling`        | Reusable interview primitive                          |
| `tdd`             | Red/green rules at pre-agreed public seams            |

Matt distinguishes user-invoked orchestrators from model-invoked disciplines. The key design rule is progressive disclosure: keep specialized process out of context until the task actually needs it.

Source: [Skills catalogue](https://www.aihero.dev/skills) · [Open-source repository](https://github.com/mattpocock/skills)

---

## 14. Anti-pattern catalogue

| Anti-pattern                    | Why it fails                                                          | Corrective move                                     |
| ------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------- |
| Vibe coding                     | Plausibility substitutes for verification                             | Add executable feedback and independent review      |
| Giant `AGENTS.md`               | Pays context cost every turn; contradictions and staleness accumulate | Minimal root + precise pointers + skills            |
| Auto-generated instruction dump | Optimizes comprehensiveness rather than relevance                     | Curate only behavior-changing rules                 |
| One giant session               | Attention degrades and unrelated work consumes the smart zone         | One task per fresh context                          |
| Mid-task context dumping        | Adds more competing tokens                                            | Clear/compact/handoff at a natural boundary         |
| Endless grilling                | Planning outruns available fidelity                                   | Prototype or implement the next reversible slice    |
| Horizontal tickets              | Integration and rework are deferred                                   | Tracer-bullet vertical slices                       |
| Oversized ticket                | Cannot fit a fresh context                                            | Split upstream; do not merely increase model effort |
| Theory before repro             | Agent guesses from code                                               | Gate diagnosis on a red-capable command             |
| Tests of internals              | Refactors break tests without behavior change                         | Test public seams                                   |
| Tautological expected values    | Test can pass by construction                                         | Use spec, literal example, or independent oracle    |
| Same-context self-review        | Shared assumptions create confirmation bias                           | Fresh reviewer and fixed diff                       |
| Review-until-clean loop         | Judgment-based findings do not necessarily converge                   | Validate cited leads and stop intentionally         |
| Recursive sub-agent fan-out     | Hidden cost and duplicated work                                       | Structural depth limit and explicit no-redelegation |
| Permanent research cache        | Stale facts poison later sessions                                     | Expiry/revalidation or archive/delete               |
| Single-session autonomous loop  | Progress history fills context                                        | Fresh process/context each iteration                |
| Green log without evidence      | Status is asserted, not attested                                      | Bind verdict to commands and artifacts              |

---

## 15. Application to LenGentic

> **DERIVED SECTION.** Not reported from AI Hero. See the provenance warning above.

### Adopt directly

- Fresh-context execution unit = one ticket/decision slice.
- Tracer bullets instead of layer-based stages.
- `CONTEXT.md`-like ubiquitous language for stable product terms.
- ADRs for agent-policy and orchestration trade-offs.
- Research artifacts with source, date, and expiry.
- Minimal always-on prompts; progressive skill loading.
- Pre-agreed validation seams and independent oracles.
- Standards and Spec as separate verdicts.
- HITL learning phase before AFK autonomy.
- Strict task, retry, cost, time, and delegation bounds.

### Extend for LenGentic's differentiator

Matt's workflow optimizes engineering execution. LenGentic can add the missing operations layer:

- outcome attestation, not self-reported completion;
- evidence graph linking claims to commands/logs/artifacts;
- workflow/model versioning;
- context health and token-cost telemetry;
- false-green detection;
- repeated-decision analysis and deterministic extraction;
- evaluator separation from builder;
- cross-run retrospective without bloating the next run's prompt.

### Tension to manage

Your existing instinct is to create many named roles. Matt's public design favors small, composable disciplines and uses sub-agents mainly for isolation. For LenGentic, retain roles only where they create a distinct authority, context boundary, or evidence source. If two roles differ only by prose, merge them into one skill with a clear mode.

Practical rule:

```text
A role earns existence only if it changes at least one of:
- permissions
- context inputs
- model/tool choice
- output schema
- verification authority
- lifecycle/stop condition
```

This section is an El/LenGentic synthesis, not a direct Matt quotation.

---

## 16. Reusable operating policy

Use this as a compact baseline when applying the knowledge base:

```text
MATT-ALIGNED ENGINEERING POLICY

1. Clarify unresolved product decisions before implementation.
2. Keep always-loaded instructions minimal; disclose specialized guidance on demand.
3. One bounded task per fresh context. Split work before context quality degrades.
4. Build vertical tracer bullets, each independently demonstrable.
5. Agree public test seams before tests. Red first; minimal green next.
6. Do not diagnose without a named red-capable reproduction command.
7. Verify with types, focused tests, runtime probes, then one final full sweep.
8. Review from fresh context against two axes: Standards and Spec.
9. Treat agent statements as hypotheses; trust cited artifacts and observed commands.
10. Persist stable language and consequential decisions; expire temporary research.
11. Bound autonomous loops by task, iterations, time, cost, permissions, and delegation depth.
12. DONE requires evidence. Otherwise return BLOCKED or FAILED with the reason.
```

---

## 17. Source registry

### Canonical discovery and open source

- [AI Hero](https://www.aihero.dev/)
- [Public skills catalogue](https://www.aihero.dev/skills)
- [Open-source skills repository](https://github.com/mattpocock/skills)
- [AI Hero public discovery guide](https://www.aihero.dev/llms.txt)
- [AI Coding Dictionary](https://www.aihero.dev/ai-coding-dictionary)

### Workflow and skills

- [Seven phases of AI development](https://www.aihero.dev/my-7-phases-of-ai-development)
- [`grill-with-docs`](https://www.aihero.dev/skills-grill-with-docs)
- [`to-spec`](https://www.aihero.dev/skills-to-spec)
- [`to-tickets`](https://www.aihero.dev/skills-to-tickets)
- [`implement`](https://www.aihero.dev/skills-implement)
- [`code-review`](https://www.aihero.dev/skills-code-review)
- [`tdd`](https://www.aihero.dev/skills-tdd)
- [`diagnosing-bugs`](https://www.aihero.dev/skills-diagnosing-bugs)
- [`research`](https://www.aihero.dev/skills-research)
- [`writing-for-agents`](https://www.aihero.dev/skills-writing-for-agents)
- [`handoff`](https://www.aihero.dev/skills-handoff)

### Context, architecture, and autonomy

- [Smart zone](https://www.aihero.dev/ai-coding-dictionary/smart-zone)
- [Attention degradation](https://www.aihero.dev/ai-coding-dictionary/attention-degradation)
- [Complete guide to AGENTS.md](https://www.aihero.dev/a-complete-guide-to-agents-md)
- [How to make codebases AI agents love](https://www.aihero.dev/how-to-make-codebases-ai-agents-love)
- [Plan mode](https://www.aihero.dev/plan-mode-introduction)
- [Getting started with Ralph](https://www.aihero.dev/getting-started-with-ralph)
- [11 Ralph tips](https://www.aihero.dev/tips-for-ai-coding-with-ralph-wiggum)
- [Why one-session Ralph degrades](https://www.aihero.dev/why-the-anthropic-ralph-plugin-sucks)
- [Common grilling mistakes](https://www.aihero.dev/things-people-get-wrong-with-grill-me-and-grill-with-docs)

---

## 18. Update protocol

When refreshing this knowledge base:

1. Check [AI Hero posts](https://www.aihero.dev/posts), [skills catalogue](https://www.aihero.dev/skills), the [repository changelog](https://github.com/mattpocock/skills/blob/main/CHANGELOG.md), and repository releases.
2. Prefer first-party AI Hero pages and source files over commentary about Matt.
3. Record the research date and skill-set version.
4. Separate changed doctrine from renamed/repackaged skills.
5. Mark unresolved inconsistencies and known bugs; do not normalize them away.
6. Revalidate numeric/model-specific claims because context sizes, model behavior, and tools change quickly.
7. Keep El/LenGentic adaptations explicitly labelled.
8. Delete or revise stale guidance instead of appending contradictory rules.

Refreshing this note updates `researched` and `review-by` in the front matter, and the
row in `docs/research/README.md`. Per `docs/research/README.md`, a note past `review-by`
may be revalidated, archived, or deleted — never cited as-is.
