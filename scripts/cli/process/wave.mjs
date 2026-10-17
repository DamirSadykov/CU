export const DEFAULT_PARALLEL_LIMIT = 1;

export const declaredRed = (t) => (t && t.red && String(t.red).trim()) || "";

export function buildWave(ready, limit) {
  if (!ready.length) return [];
  if (declaredRed(ready[0])) return [ready[0]];
  const wave = [];
  const produced = new Set();
  for (const t of ready) {
    if (wave.length >= limit || declaredRed(t)) break;
    const paths = (Array.isArray(t.produces) ? t.produces : [])
      .filter(Boolean)
      .map((p) => String(p).replace(/\\/g, "/"));
    if (paths.some((p) => produced.has(p))) continue;
    wave.push(t);
    for (const p of paths) produced.add(p);
  }
  return wave;
}

export function resolveParallelLimit(root, override) {
  return (
    (typeof override === "number" && override > 0 && Math.floor(override)) ||
    (typeof root.parallel_limit === "number" && root.parallel_limit > 0
      ? Math.floor(root.parallel_limit)
      : DEFAULT_PARALLEL_LIMIT)
  );
}

const ids = (wave) => wave.map((t) => t.id);

export const WAVE_RULES = [
  {
    rule: "A step with `red` always runs alone, even with `parallel` above 1.",
    example: () => ids(buildWave([{ id: "a", red: "npm test" }, { id: "b" }], 3)),
    expect: ["a"],
  },
  {
    rule: "A step with `red` also closes the wave before it: ready steps listed after it wait for the next wave.",
    example: () => ids(buildWave([{ id: "a" }, { id: "b", red: "npm test" }, { id: "c" }], 3)),
    expect: ["a"],
  },
  {
    rule: "Two steps that share a path in `produces` never run in one wave, whatever `needs` says.",
    example: () => ids(buildWave([{ id: "a", produces: ["x.mjs"] }, { id: "b", produces: ["x.mjs"] }], 3)),
    expect: ["a"],
  },
  {
    rule: "`parallel: N` caps a wave at N steps; it does not make steps parallel — only the absence of a `needs` edge does.",
    example: () => ids(buildWave([{ id: "a" }, { id: "b" }, { id: "c" }], 2)),
    expect: ["a", "b"],
  },
  {
    rule: "Without `parallel` on the change the limit is 1: steps run one at a time.",
    example: () => resolveParallelLimit({}),
    expect: 1,
  },
];
