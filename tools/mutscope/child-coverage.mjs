import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

process.on("exit", () => {
  const directory = process.env.MUTSCOPE_CHILD_COVERAGE;
  const coverage = globalThis.__stryker__?.mutantCoverage;
  if (!directory || !coverage) return;
  const hits = { ...coverage.static };
  for (const perTest of Object.values(coverage.perTest ?? {})) {
    for (const [id, count] of Object.entries(perTest)) hits[id] = (hits[id] ?? 0) + count;
  }
  if (Object.keys(hits).length === 0) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${process.pid}.json`), JSON.stringify(hits));
});
