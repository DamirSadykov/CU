# Plan graph format

A plan is markdown for the user plus ONE ```` ```yaml ```` block the tracker
records. Write the brief freely: goal, context, decisions, risks. Text outside
the block becomes the plan's `vision` unless the block declares one. The block
holds the task graph: one task/work session per step. Omitted runner fields are
inferred; explicit values win.

## 0. When to write a draft plan

Scout: locate files and size each task S/M/L. Any L task or open branch requires
plan mode; use `<cli> todos apply` only for auto-runner work. Otherwise a draft
plan is optional. Keep its graph current. Decide after scouting, not by edit count.

## 1. Block shape

```ts
type Plan = {
  change: string | `c#${number}`
  vision?: string
  out?: { what: string; why: string; ref?: string }[]
  measure?: { what: string; how: string; target?: string; actual?: string; ok?: boolean; note?: string }[]
  parallel?: number
  budget?: number
  steps: { [id: StepId]: Step }
}

type Step = ({ title: string } | { task: number | `t#${number}` | Uuid }) & {
  why: string
  needs?: (StepId | TaskRef)[]
  produces?: Path[]
  verify?: Command
  retry?: number
  "on-issue"?: StepId
  kind?: "auto" | "manual"
  size?: "S" | "M" | "L"
  budget?: number
  red?: Command
  "red-tests"?: Path[]
  flow?: FlowDelta | FlowDelta[] | `n/a ${string}`
  risk?: "high" | "sensitive"
}

type FlowDelta = {
  file: Path
  method: string
  params?: string
  change: FlowChange[]
  preserve?: "all" | "none"
  keep?: Call[]
}

type FlowChange =
  | { insert: Call; after?: Call; before?: Call; nth?: number; guard?: "none" | "returns-bool" }
  | { "remove-call": Call }
  | { "remove-read": string }
```

Linking: `needs` lists only blockers, by step id or existing task; `task`
continues a board task instead of a new `title`; `on-issue` names a decided
corrective step.

Inference and rules:

- `size` is required for a new `auto` task: S = point edit, M = multi-file
  feature, L = connected rework with tests and a document.
- `kind` omitted: `auto` with `verify`, otherwise `manual`.
- `retry` omitted: `2`; declare another value only with its reason in `why`.
- `budget` omitted: history translates `size` into dollars.
- `red` must fail on the base state; its test path fills `red-tests`.
- `flow` is required for code in configured languages: a [method delta](flow-delta.md). `params` picks an
  overload; `nth` = 1-based occurrence of `before`; `preserve: all` (default)
  keeps every base step in order; `keep` names steps that must survive.
- `why` is the task's durable reasoning: its basis and risk.

## 2. Graph skeleton

```yaml
change: "PLAN: webhook delivery is observable"
steps:
  1:
    title: Delivery state is recorded
    why: Both branches need receipt proof.
    size: S
    produces: [src/delivery.ts]
    verify: npm run test:delivery-state
    flow:
      file: src/delivery.ts
      method: deliver
      change:
        - insert: recordDeliveryState
          after: send
  dup:
    title: Duplicate delivery has a regression test
    why: The new regression file fails on the old code.
    size: S
    produces: [test/webhook-duplicate.test.mjs]
    flow: n/a test only
    verify: npx vitest run test/webhook-duplicate.test.mjs
    red: npx vitest run test/webhook-duplicate.test.mjs
  2:
    title: Operators accept dashboard thresholds
    why: Threshold usefulness needs human judgement.
    needs: [1]
  3:
    task: 318
    why: The existing runbook task joins recorded state and accepted thresholds.
    needs: [1, 2]
    produces: [docs/delivery-runbook.md]
    verify: npm run docs:check
```

## 3. Recording and refusals

The ExitPlanMode hook records an approved plan. Fallback only when the hook says
it could not read the plan:

```
<cli> todos apply <plan>.yaml
<cli> todos apply <plan>.yaml --go
<cli> todos lint [<plan>] [--json]
```

`apply` prints every inferred value as `выведено` and writes it to the board.
A refusal explains invalid `out` and `measure` items.

For a draft plan that settles a question and records no work, start with:

```
discussion: <what is being settled, and why it opens no task>
```

Open [`plan-format-issues.md`](plan-format-issues.md) only when a task parks.
Open [`plan-format-cutting.md`](plan-format-cutting.md) only when a plan or task
must be split.
