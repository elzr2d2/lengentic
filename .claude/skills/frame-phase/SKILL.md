---
name: frame-phase
description: Frame a phase before any code is written — read its Definition of Done, surface every open decision, and grill them to settled answers in rounds. Use when starting a phase, or when a packet turns out to rest on a decision nobody made.
---

# Frame Phase

The most expensive failure in this project is not a bug. It is a wave of Builders shipping
against a decision nobody made, discovered at the phase gate.

This skill spends one sitting up front to make that impossible. It ends when every branch of
the phase is settled or explicitly deferred — not when the questions run out.

## 1. Read the phase, now

Read the phase's **Definition of Done** from the plan, in full, from the document. Not from
memory, not from the task list, not from a summary. `CLAUDE.md` names which plan is
authoritative.

Then `pnpm oracle waves` for the deliverables and their dependency order.

## 2. Surface every open decision

An **open decision** is a hard stop, not a default. Collect them from:

- the plan's own open-decision markers for this phase,
- `BACKLOG.md` items whose deferral this phase would reverse,
- every deliverable where two readings of the plan produce materially different code,
- anything a previous phase left as carried debt that this phase now touches.

Finding **facts** is your job, never the user's. When a question needs something the
filesystem, the git history, or a command can answer, dispatch a sub-agent and find it. Only
put **decisions** to the user.

## 3. Grill in rounds

Map the phase as a **design tree**: each decision branches into the decisions hanging off it.

The **frontier** is every decision whose prerequisites are already settled — the questions
you can ask _now_ without guessing at answers you have not heard. Ask the whole frontier in
one round, each question numbered and carrying **your recommended answer**:

```
❓ **Q1** — **<question title>**: <the question, with the options and what each costs>

➡️ <your recommendation, and why>
```

Then wait. Each round of answers reshapes the tree: settled decisions push the frontier
outward and unblock what depended on them. A question whose answer depends on another
question still open belongs to a **later** round, not this one.

A running sub-agent exploration is an unsettled prerequisite — only the questions downstream
of it wait. Ask the rest of the frontier now.

When a round does **not** converge and the decision is **one-way** — the wire contract under
`platform/shared/schema/**`, the platform↔playground boundary, or a product claim — name it
and offer the council. Never convene it yourself. Architect is the cheaper rung and runs
first; the council is eleven dispatches, and the user decides whether to spend them.

## 4. Land the answers where they will be read

An answer that lives only in this conversation is an answer nobody has next session.

| The answer is…                                           | It lands in                                         |
| -------------------------------------------------------- | --------------------------------------------------- |
| A term, or a distinction the code should name            | `CONTEXT.md`                                        |
| A decision with a rejected alternative worth remembering | the plan, or `docs/`                                |
| Valuable and outside this phase's Definition of Done     | `BACKLOG.md`, with its `Source`                     |
| A constraint on one deliverable                          | the packet, so `pnpm oracle packet <id>` carries it |

Use the `update-backlog` skill for the third row.

## 5. Slice, then stop

With the frontier empty, restate the phase as **work packets**: each a narrow but complete
vertical slice through every layer, demoable on its own, sized to fit one fresh context
window. Check the wave assignment for lane collisions — two packets in one wave touching the
same directory get serialised or given a worktree, never dispatched into the same tree.

Then confirm the framing — how depends on who is driving. Outside autopilot, **stop**: the
user says whether shared understanding was reached. Under the `autopilot` skill, the approved
charter is that confirmation: check the six triggers in `CLAUDE.md`; when none fires, record
the framing outcome in the checkpoint and proceed to dispatch without asking. A frontier that
did not empty is trigger 3 in both modes — an open decision stops the phase, not a missing
"shall I continue".

## Done when

The frontier is empty: every branch visited, nothing silently assumed, every settled answer
written somewhere a fresh session will find it.

A phase framed with one open decision remaining is a phase that will stop mid-wave. Say
which decision is open and who owns it rather than defaulting it.
