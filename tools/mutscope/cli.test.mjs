import { describe, expect, it, vi } from "vitest";
import {
  combineChangeReports, formatSummary, parseCliArgs, runMutscope, summarizeMutationReport, summaryOutput,
} from "./cli.mjs";

function report(file, language, mutants, tests = []) {
  return {
    schemaVersion: "1.0",
    files: { [file]: { language, source: "", mutants } },
    testFiles: tests.length ? { "tests/value.test.ts": { source: "", tests } } : {},
    mutscope: { levels: [{ level: 0, durationMs: 2, tests: ["tests/value.test.ts"], mutants: mutants.length }] },
  };
}

describe("mutscope CLI", () => {
  it("parses ladder, diff and output options and rejects ambiguous sources", () => {
    expect(parseCliArgs(["--from", "1", "--to", "2", "--keep-strings", "--output", "out.json", "main", "HEAD"]))
      .toMatchObject({ from: 1, to: 2, keepStrings: true, output: "out.json", revisions: ["main", "HEAD"] });
    expect(() => parseCliArgs(["--from", "3", "--to", "1"])).toThrow(/must not exceed/);
    expect(() => parseCliArgs(["--staged", "main"])).toThrow(/cannot be combined/);
    expect(() => parseCliArgs(["--diff-file", "change.diff", "main"])).toThrow(/cannot be combined/);
  });

  it("routes each changed source to its adapter with a derived ladder", async () => {
    const diff = [
      "diff --git a/src/value.ts b/src/value.ts", "+++ b/src/value.ts", "@@ -1 +1 @@", "+export const value = 2;",
      "diff --git a/crates/core/src/lib.rs b/crates/core/src/lib.rs", "+++ b/crates/core/src/lib.rs", "@@ -4 +4 @@", "+pub fn value() -> i32 { 2 }",
      "diff --git a/README.md b/README.md", "+++ b/README.md", "@@ -1 +1 @@", "+docs",
    ].join("\n");
    const discover = vi.fn(async ({ changedFile }) => [{ level: 0, tests: [`${changedFile}.test`] }]);
    const runStryker = vi.fn(async ({ mutate }) => report("src/value.ts", "typescript", [{
      id: "js", status: "Killed", mutatorName: "BooleanLiteral", location: {}, coveredBy: ["0"], killedBy: ["0"], level: 0,
    }], [{ id: "0", name: "kills js" }]));
    const runCargo = vi.fn(async ({ mutate }) => {
      expect(mutate).toEqual([{ file: "crates/core/src/lib.rs", ranges: [{ startLine: 4, endLine: 4 }], language: "rust" }]);
      return report("crates/core/src/lib.rs", "rust", [{ id: "rs", status: "Survived", coveredBy: [], level: 0 }]);
    });

    const output = await runMutscope({ cwd: "C:/repo", diff, discover, runStryker, runCargo, strykerRunner: vi.fn(), cargoRunner: vi.fn(), quarantine: vi.fn() });
    expect(discover).toHaveBeenCalledTimes(2);
    expect(runStryker).toHaveBeenCalledOnce();
    expect(runStryker.mock.calls[0][0].mutate).toEqual(["src/value.ts:1-1"]);
    expect(runCargo).toHaveBeenCalledOnce();
    expect(output.mutscope.changes).toEqual([
      { file: "src/value.ts", language: "js" },
      { file: "crates/core/src/lib.rs", language: "rust" },
    ]);
  });

  it("remaps test ids while combining per-change reports", () => {
    const js = report("src/a.ts", "typescript", [{ id: "a", status: "Killed", coveredBy: ["0"], killedBy: ["0"] }], [{ id: "0", name: "a test" }]);
    const rust = report("src/b.rs", "rust", [{ id: "b", status: "Killed", coveredBy: ["0"], killedBy: ["0"] }], [{ id: "0", name: "b test" }]);
    const combined = combineChangeReports([
      { file: "src/a.ts", language: "js", report: js },
      { file: "src/b.rs", language: "rust", report: rust },
    ]);
    expect(combined.testFiles["tests/value.test.ts"].tests.map((test) => test.id)).toEqual(["0", "1"]);
    expect(combined.files["src/b.rs"].mutants[0].killedBy).toEqual(["1"]);
    expect(combined.mutscope.levels[1]).toMatchObject({ file: "src/b.rs", level: 0 });
  });

  it("summarizes killing tests and separates covered from uncovered survivors", () => {
    const output = report("src/value.ts", "typescript", [
      { id: "k", status: "Killed", killedBy: ["0"], coveredBy: ["0"] },
      { id: "c", status: "Survived", coveredBy: ["0"] },
      { id: "u", status: "NoCoverage", coveredBy: [] },
    ], [{ id: "0", name: "value test" }]);
    const summary = summarizeMutationReport(output);
    expect(summary).toMatchObject({ mutants: 3, killed: 1 });
    expect(summary.selectedTests).toEqual([{ file: "tests/value.test.ts", name: "value test" }]);
    expect(summary.survivedCovered.map((mutant) => mutant.id)).toEqual(["c"]);
    expect(summary.survivedUncovered.map((mutant) => mutant.id)).toEqual(["u"]);
    expect(formatSummary(summary)).toContain("Survived without coverage: 1");
  });

  it("prints a parseable JSON summary that carries the report path", () => {
    const summary = summarizeMutationReport(report("src/value.ts", "typescript", [{ id: "k", status: "Killed", killedBy: [] }]));
    expect(JSON.parse(summaryOutput(summary, "out/report.json", true))).toMatchObject({ killed: 1, report: "out/report.json" });
    expect(summaryOutput(summary, "out/report.json")).toMatch(/\nReport: out\/report\.json\n$/);
  });
});
