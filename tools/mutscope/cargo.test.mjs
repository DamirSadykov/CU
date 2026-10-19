import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  cargoDiffSelector, cargoFailedTests, cargoMutantSelector, cargoOutcomesToMte,
  cargoTestArgs, createCargoRunner, runCargoLadder,
} from "./cargo.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "rs", "mutants.out");

function mte(status, id = "src/lib.rs:4:5: replace value with false", killedBy = []) {
  const mutant = {
    id, mutatorName: "FnValue", replacement: "false", status,
    coveredBy: killedBy,
    location: { start: { line: 4, column: 5 }, end: { line: 4, column: 9 } },
  };
  if (status === "Killed") mutant.killedBy = killedBy;
  return {
    schemaVersion: "1.0",
    files: { "src/lib.rs": { language: "rust", source: "", mutants: [mutant] } },
    testFiles: killedBy.length ? { "tests/value.rs": { source: "", tests: [{ id: killedBy[0], name: "kills_value" }] } } : {},
    framework: { name: "cargo-mutants", version: "25.3.1" },
  };
}

describe("cargo-mutants adapter", () => {
  it("builds line selectors from unified diff ranges and exact selectors for promotion", () => {
    const selector = cargoDiffSelector([{ file: "src/value.rs", ranges: [{ startLine: 3, endLine: 4 }] }]);
    expect("src/value.rs:3:9: replace value with false").toMatch(new RegExp(selector));
    expect("src/value.rs:5:9: replace value with false").not.toMatch(new RegExp(selector));
    const exact = cargoMutantSelector(["src/value.rs:3:9: replace a+b with a-b"]);
    expect("src/value.rs:3:9: replace a+b with a-b").toMatch(new RegExp(exact));
    expect("src/value.rs:3:9: replace axb with a-b").not.toMatch(new RegExp(exact));
  });

  it("turns Rust test paths into cargo target arguments", () => {
    expect(cargoTestArgs(["src/lib.rs", "tests/value.rs", "crates/core/tests/public_api.rs"]))
      .toEqual(["--lib", "--test", "value", "--test", "public_api"]);
  });

  it("runs inline tests of binary sources as binary targets, not as a library", () => {
    expect(cargoTestArgs(["src/main.rs"])).toEqual(["--bins"]);
    expect(cargoTestArgs(["src/bin/tool.rs", "src/lib.rs"])).toEqual(["--lib", "--bins"]);
  });

  it("extracts every failing test from a no-fail-fast cargo log", () => {
    const log = [
      "Running `target/debug/deps/value-aabbccddeeff0011.exe`",
      "test first ... FAILED",
      "test nested::second ... FAILED",
      "error: test failed, to rerun pass `--test value`",
    ].join("\n");
    expect(cargoFailedTests(log, ["tests/value.rs"])).toEqual([
      { file: "tests/value.rs", name: "first" },
      { file: "tests/value.rs", name: "nested::second" },
    ]);
  });

  it("normalizes the recorded outcomes and recovers killedBy from their logs", async () => {
    const outcomes = JSON.parse(await readFile(path.join(fixture, "outcomes.json"), "utf8"));
    const report = await cargoOutcomesToMte(outcomes, {
      directory: fixture,
      tests: ["tests/coverage.rs"],
    });
    const mutants = report.files["src/coverage.rs"].mutants;
    expect(mutants).toHaveLength(15);
    expect(report.framework).toEqual({ name: "cargo-mutants", version: outcomes.cargo_mutants_version });
    expect(mutants.find((mutant) => mutant.id.includes("named -> bool with true"))).toMatchObject({
      status: "Killed",
      mutatorName: "FnValue",
      killedBy: expect.any(Array),
      duration: 85901,
    });
    expect(mutants.find((mutant) => mutant.id.includes("named -> bool with true")).killedBy.length).toBeGreaterThan(0);
    expect(mutants.find((mutant) => mutant.id.includes("named -> bool with false"))).toMatchObject({ status: "Survived" });
    const killedNames = new Set(Object.values(report.testFiles).flatMap((file) => file.tests.map((test) => test.name)));
    expect(killedNames).toContain("declared_overload_does_not_cover_another_overload");
  });

  it("launches cargo with an exact selector, narrowed targets and no-fail-fast", async () => {
    let launched;
    const runner = createCargoRunner({
      runCommand: async (command, args) => {
        launched = { command, args };
        const output = args[args.indexOf("--output") + 1];
        const source = path.join(fixture, "outcomes.json");
        const outcomes = JSON.parse(await readFile(source, "utf8"));
        // Reuse the fixture directory through a read interception is unnecessary here: no log is fatal.
        const { mkdir, writeFile } = await import("node:fs/promises");
        await mkdir(path.join(output, "mutants.out"));
        await writeFile(path.join(output, "mutants.out", "outcomes.json"), JSON.stringify({ ...outcomes, outcomes: [] }));
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    await runner({ selector: "^one$", tests: ["tests/value.rs"] });
    expect(launched.command).toBe("cargo");
    expect(launched.args).toEqual(expect.arrayContaining([
      "mutants", "--re", "^one$", "--exclude-re", expect.any(String), "--test", "value", "--no-fail-fast",
    ]));
  });

  it("promotes only survivors by exact name and stops after they are killed", async () => {
    const calls = [];
    const survivor = "src/lib.rs:4:5: replace value with false";
    const results = [mte("Survived", survivor), mte("Killed", survivor, ["0"])];
    const output = await runCargoLadder({
      mutate: [{ file: "src/lib.rs", ranges: [{ startLine: 4, endLine: 4 }] }],
      ladder: [
        { level: 0, tests: ["tests/value.rs"] },
        { level: 1, tests: ["tests/public_api.rs"] },
        { level: 2, tests: ["tests/all.rs"] },
      ],
      runLevel: async (request) => {
        calls.push(request);
        return { report: results.shift(), durationMs: calls.length * 10 };
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].selector).toContain("src/lib\\.rs");
    expect(survivor).toMatch(new RegExp(calls[1].selector));
    expect(calls[1].mutants).toHaveLength(1);
    expect(output.files["src/lib.rs"].mutants[0]).toMatchObject({
      status: "Killed", level: 1, killedBy: ["0"], durationMsByLevel: { 0: null, 1: null },
    });
    expect(output.mutscope.levels.map((level) => level.mutants)).toEqual([1, 1]);
  });
});
