# Flow delta semantics

`flow` is a claim about named calls in a method after the task, not a prose
summary of the implementation. It is either one method delta, a non-empty list
of method deltas, or `n/a <reason>`. A delta names `file`, `method`, optional
`params`, `change`, and optional `preserve`.

- `insert: X` means that the resulting method contains a call named `X`. `X`
  must already exist in the code, or the task description must explicitly say
  that it introduces a new function named `X`. A variable, property read, or
  expression written inline in the method is not a call and does not satisfy
  `insert`.
- `after: Y` on `insert: X` means that every execution path reaching `X` has
  already passed a call named `Y`. It does not merely mean that `Y` appears
  earlier in the source. Declare `after` only when that ordering is itself a
  requirement; otherwise declare only `insert: X`.
- `before: Y` requires the inserted call before the selected `Y` anchor on
  every path. Without `nth`, every matching `Y` call is an anchor.
- `nth: N` is a 1-based selector for a `before` anchor: only occurrence `N` of
  `Y` is checked. It currently has no checking meaning with `after`, so do not
  use that combination.
- `preserve: all` (the default) requires the calls and reads seen in the base
  method to remain in their previous relative order, except for steps declared
  as removed. `preserve: none` disables that comparison; use it only when the
  task intentionally replaces or reorders the existing flow.
- `guard` changes the `before` predicate (for example, `returns-bool` rejects a
  dropped result and requires a recognized boolean guard); it is not a general
  proof of business semantics.

The verdict and the diagnostic coverage are deliberately separate. A declared
delta produces one `results[]` row per method. `results[].status: fail` makes
the flow gate red: for example, a declared call is absent, an `after`/`before`
relation fails, the selected `nth` anchor does not exist, or `preserve: all`
finds a lost or reordered base step. `coverage` reports changed methods outside
the declared delta, while `unchecked` reports observations the tool could not
prove (such as an undeclared step, unsupported file, or depth limit). The
runner invokes coverage in `shadow` mode, so neither `coverage` nor `unchecked`
changes the verdict. They are review prompts, not reasons to add invented
deltas merely to make the report empty.

Use `flow: n/a <reason>` when the task changes code but makes no honest,
checkable claim about named calls in a method: for example, it changes only an
inline expression, data, types, tests, configuration, or a condition that the
current delta language cannot express. Also use it when the task description
does not decide a call name or an ordering requirement. State the concrete
reason; guessing `insert` or `after` makes the gate test the plan author's
fiction instead of the implementation.

## Examples from p#122

- **t#1326.** Was in the plan: `insert: codexSessionId`, `after:
  CLAUDE_CODE_SESSION_ID`. Flowcheck understood: “`currentSessionId` calls a
  function named `codexSessionId`, after a call named
  `CLAUDE_CODE_SESSION_ID`.” Both names described inline environment access,
  not calls. Write instead: `flow: n/a inline CODEX_SESSION_ID lookup adds no
  named call`; alternatively, first require a new `codexSessionId` function in
  the task description and then declare its call.
- **t#1327.** Was in the plan: `insert: codexRolloutHasWorkSince`, `after:
  transcriptHasAgentCallSince`. Flowcheck understood: “on every path to the new
  call, the transcript check has already run.” The task required two ways to
  recognize work, not their execution order. Write instead: `insert:
  codexRolloutHasWorkSince`, with no `after`.
- **t#1328.** Was in the plan: `insert: codexRollouts`, `after:
  claudeProjectsDir`. Flowcheck understood `codexRollouts` as a function call
  and failed when the implementation used no such call. At the same time,
  correct changes in other methods appeared only in shadow `coverage`; those
  findings did not make the verdict red. Write the actual call that the task
  requires as `insert` (and a separate method delta for each required method),
  or use `flow: n/a inline rollout collection; no named call is required` if
  the implementation shape is intentionally undecided.
