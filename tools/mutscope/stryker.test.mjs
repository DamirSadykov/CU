import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, strykerMutatePatterns } from "./diff.mjs";
import { mergeMutationReports } from "./report.mjs";
import {
  buildStrykerConfig,
  createStrykerRunner,
  createThreadQuarantine,
  envSetupSource,
  filesOfFailedTests,
  runStrykerLadder,
  strykerMutantSelector, summarizeTrace, vitestConfigSource } from "./stryker.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function report(status, {
  id = "1", mutatorName = "ConditionalExpression", testId = "10", testName = "kills it",
} = {}) {
  const mutant = {
    id,
    mutatorName,
    replacement: "false",
    status,
    static: false,
    coveredBy: status === "NoCoverage" ? [] : [testId],
    location: { start: { line: 4, column: 2 }, end: { line: 4, column: 8 } },
  };
  if (status === "Killed") mutant.killedBy = [testId];
  return {
    schemaVersion: "1.0",
    files: { "src/value.ts": { language: "typescript", source: "export const value = true", mutants: [mutant] } },
    testFiles: { "test/value.test.ts": { source: "", tests: [{ id: testId, name: testName }] } },
    framework: { name: "StrykerJS", version: "10.0.0" },
  };
}

describe("unified diff ranges", () => {
  it("returns compact new-file ranges and anchors pure deletions", () => {
    const diff = [
      "diff --git a/src/value.ts b/src/value.ts",
      "--- a/src/value.ts",
      "+++ b/src/value.ts",
      "@@ -2,4 +2,4 @@",
      " same",
      "-old",
      "+new",
      "+another",
      " tail",
      "diff --git a/src/gone.ts b/src/gone.ts",
      "--- a/src/gone.ts",
      "+++ b/src/gone.ts",
      "@@ -7,2 +7 @@",
      "-removed",
      " kept",
    ].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual([
      { file: "src/value.ts", ranges: [{ startLine: 3, endLine: 4 }] },
      { file: "src/gone.ts", ranges: [{ startLine: 7, endLine: 7 }] },
    ]);
    expect(strykerMutatePatterns(diff)).toEqual(["src/value.ts:3-4", "src/gone.ts:7-7"]);
  });
});

describe("Stryker adapter", () => {
  it("resolves and launches the repository-installed Stryker CLI by default", async () => {
    let launched;
    const runner = createStrykerRunner({
      runCommand: async (command, args) => {
        launched = { command, args };
        await access(args[0]);
        const config = JSON.parse(await readFile(args[2], "utf8"));
        await writeFile(config.jsonReporter.fileName, JSON.stringify(report("Killed")), "utf8");
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    await runner({ mutate: ["src/value.ts:4-4"], tests: ["test/value.test.ts"] });

    expect(launched.command).toBe(process.execPath);
    expect(launched.args[0].replaceAll("\\", "/")).toMatch(
      /node_modules\/@stryker-mutator\/core\/bin\/stryker\.js$/,
    );
    expect(launched.args.slice(1, 2)).toEqual(["run"]);
  });

  it("names the tests that failed the initial test run", async () => {
    const stdout = [
      "\u001b[91m08:37:15 (1) ERROR DryRunExecutor\u001b[39m One or more tests failed in the initial test run:",
      "\tmissing produces t#1130: counts the mtime",
      "\t\texpected { …(9) } to match object",
      "\u001b[91m08:37:15 (1) ERROR Stryker\u001b[39m There were failed tests in the initial test run.",
    ].join("\n");
    const runner = createStrykerRunner({
      ignorePatterns: [],
      runCommand: async () => ({ code: 1, stdout, stderr: "" }),
    });
    const error = await runner({ mutate: ["src/value.ts:4-4"], tests: ["test/value.test.ts"] }).catch((caught) => caught);
    expect(error.failedTests).toEqual(["missing produces t#1130: counts the mtime"]);
  });

  it("leaves other Stryker failures without failed tests", async () => {
    const runner = createStrykerRunner({
      ignorePatterns: [],
      runCommand: async () => ({ code: 1, stdout: "ERROR config broken", stderr: "" }),
    });
    const error = await runner({ mutate: ["src/value.ts:4-4"], tests: ["test/value.test.ts"] }).catch((caught) => caught);
    expect(error.message).toMatch(/exited with 1/);
    expect(error).not.toHaveProperty("failedTests");
  });

  it("maps failed test names to the files that declare them", () => {
    const sources = [
      ["a.test.mjs", 'describe("missing produces", () => { it("t#1130: counts the mtime", () => {}); });'],
      ["b.test.mjs", 'describe("other", () => { it("t#1130: counts the mtime", () => {}); });'],
      ["c.test.mjs", 'test("standalone", () => {});'],
    ];
    expect(filesOfFailedTests(["missing produces t#1130: counts the mtime", "standalone"], sources))
      .toEqual(["a.test.mjs", "c.test.mjs"]);
  });

  it("quarantines files whose tests fail the initial run and reruns the level without them", async () => {
    const calls = [];
    const output = await runStrykerLadder({
      mutate: ["src/value.ts:4-4"],
      ladder: [{ level: 2, tests: ["a.test.mjs", "b.test.mjs"] }],
      readSource: async (file) => (file === "a.test.mjs" ? 'describe("s", () => { it("breaks", () => {}); });' : 'it("fine", () => {});'),
      runLevel: async (request) => {
        calls.push(request.tests);
        if (request.tests.includes("a.test.mjs")) throw Object.assign(new Error("dry run"), { failedTests: ["s breaks"] });
        return { report: report("Killed"), durationMs: 1 };
      },
    });
    expect(calls).toEqual([["a.test.mjs", "b.test.mjs"], ["b.test.mjs"]]);
    expect(output.mutscope.quarantined).toEqual([{ level: 2, file: "a.test.mjs", reason: "dryRun", tests: ["s breaks"] }]);
    expect(output.mutscope.traces[0].dryRunFailures).toBe(1);
  });

  it("forces complete per-test runs and excludes string mutations by default", () => {
    const config = buildStrykerConfig({
      baseConfig: { reporters: ["html"], mutator: { excludedMutations: ["Regex"] } },
      mutate: ["src/value.ts:3-5"],
      reportFile: "out.json",
      vitestConfigFile: "vitest.config.mjs",
      ignorePatterns: ["/src-tauri/target"],
    });
    expect(config).toMatchObject({
      disableBail: true,
      coverageAnalysis: "perTest",
      allowEmpty: true,
      reporters: ["json"],
      vitest: { configFile: "vitest.config.mjs", related: false },
      ignorePatterns: ["/src-tauri/target"],
      mutator: { excludedMutations: ["Regex", "StringLiteral"] },
    });
    expect(config).not.toHaveProperty("testFiles");
  });

  it("narrows vitest to the level's tests through a generated config", () => {
    const source = vitestConfigSource({ tests: ["scripts\\a.test.mjs"], baseConfigFile: path.join(here, "vite.config.ts") });
    expect(source).toContain('include: ["scripts/a.test.mjs"]');
    expect(source).toMatch(/^import base from "file:/);
  });

  it("hands the active mutant and the child coverage hook to launched processes", () => {
    const source = envSetupSource("C:/repo/node_modules/vitest/dist/index.js", { coverageRoot: "C:/tmp/cov" });
    expect(source).toContain("__STRYKER_ACTIVE_MUTANT__");
    expect(source).toContain("--import=file:");
    expect(source).toContain("child-coverage.mjs");
    expect(source).toContain('"C:/tmp/cov"');
  });

  it("writes the coverage a child process collected on exit", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mutscope-child-"));
    try {
      execFileSync(process.execPath, [
        "--import", pathToFileURL(path.join(here, "child-coverage.mjs")).href,
        "-e", "globalThis.__stryker__ = { mutantCoverage: { static: { 3: 1 }, perTest: { t: { 3: 1, 4: 2 } } } };",
      ], { env: { ...process.env, MUTSCOPE_CHILD_COVERAGE: directory } });
      const files = await readdir(directory);
      expect(files).toHaveLength(1);
      expect(JSON.parse(await readFile(path.join(directory, files[0]), "utf8"))).toEqual({ 3: 2, 4: 2 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("starts at the first level that has tests", async () => {
    const calls = [];
    await runStrykerLadder({
      mutate: ["src/value.ts:4-4"],
      ladder: [{ level: 0, tests: [] }, { level: 1, tests: ["test/integration.test.ts"] }],
      runLevel: async (request) => { calls.push(request); return { report: report("Killed"), durationMs: 1 }; },
    });
    expect(calls.map((call) => call.level)).toEqual([1]);
  });

  it("drops quarantined tests per level and reports them", async () => {
    const calls = [];
    const output = await runStrykerLadder({
      mutate: ["src/value.ts:4-4"],
      ladder: [
        { level: 0, tests: ["test/isolated.test.ts"] },
        { level: 1, tests: ["test/isolated.test.ts", "test/shared.test.ts"] },
      ],
      quarantine: async (tests) => ({
        tests: tests.filter((test) => test !== "test/isolated.test.ts"),
        skipped: tests.filter((test) => test === "test/isolated.test.ts"),
      }),
      runLevel: async (request) => { calls.push(request); return { report: report("Killed"), durationMs: 1 }; },
    });
    expect(calls.map((call) => [call.level, call.tests])).toEqual([[1, ["test/shared.test.ts"]]]);
    expect(output.mutscope.quarantined).toEqual([
      { level: 0, file: "test/isolated.test.ts", reason: "threads" },
      { level: 1, file: "test/isolated.test.ts", reason: "threads" },
    ]);
  });

  it("probes test files under the threads pool once per content hash", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "mutscope-quarantine-"));
    try {
      await writeFile(path.join(cwd, "a.test.mjs"), "a", "utf8");
      await writeFile(path.join(cwd, "b.test.mjs"), "b", "utf8");
      const launches = [];
      const quarantine = createThreadQuarantine({
        cwd,
        vitestBin: () => "vitest.mjs",
        baseVitestConfig: undefined,
        runCommand: async (command, args) => {
          launches.push(args);
          const outputFile = args[args.indexOf("--outputFile") + 1];
          await writeFile(outputFile, JSON.stringify({ testResults: [
            { name: path.join(cwd, "a.test.mjs"), status: "passed" },
            { name: path.join(cwd, "b.test.mjs"), status: "failed" },
          ] }), "utf8");
          return { code: 1, stdout: "", stderr: "" };
        },
      });
      const tests = ["a.test.mjs", "b.test.mjs"];
      expect(await quarantine(tests)).toEqual({ tests: ["a.test.mjs"], skipped: ["b.test.mjs"] });
      expect(await quarantine(tests)).toEqual({ tests: ["a.test.mjs"], skipped: ["b.test.mjs"] });
      expect(launches).toHaveLength(1);
      expect(launches[0]).toEqual(expect.arrayContaining(["--pool", "threads", "--maxWorkers", "1"]));
      await writeFile(path.join(cwd, "b.test.mjs"), "b2", "utf8");
      await quarantine(tests);
      expect(launches).toHaveLength(2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("summarizes Stryker phases, plan timeouts and time between mutant results", () => {
    const summary = summarizeTrace([
      { t: 0, event: "created", concurrency: 3 },
      { t: 900, event: "dryRun", net: 400, overhead: 500, tests: [{ name: "a", file: "a.test.mjs", ms: 10 }, { name: "b", file: "b.test.mjs", ms: 300 }] },
      { t: 1000, event: "plan", mutants: [
        { id: "1", mutator: "BlockStatement", line: 40, plan: "Run", tests: 2, timeoutMs: 5600, netMs: 310 },
        { id: "2", mutator: "BooleanLiteral", line: 41, plan: "EarlyResult", status: "NoCoverage", tests: null, timeoutMs: null, netMs: null },
      ] },
      { t: 1000, event: "mutant", id: "2", status: "NoCoverage" },
      { t: 6700, event: "mutant", id: "1", status: "Timeout" },
    ], [{ t: 50, line: "12:00:00 (1) INFO Instrumenter Instrumented 1 source file(s) with 2 mutant(s)" }]);
    expect(summary).toMatchObject({
      stryker: { instrumented: 50 },
      concurrency: 3,
      dryRun: { netMs: 400, overheadMs: 500, tests: 2, slowest: [{ name: "b" }, { name: "a" }] },
      plan: { run: 1, early: 1, timeoutMs: { median: 5600, max: 5600 }, netMs: 310 },
      mutants: {
        byStatus: { NoCoverage: { count: 1, gapMs: 0 }, Timeout: { count: 1, gapMs: 5700 } },
        timeouts: [{ id: "1", line: 40, timeoutMs: 5600 }],
      },
    });
  });

  it("promotes timeouts nobody covered", async () => {
    const calls = [];
    const uncovered = report("Timeout");
    uncovered.files["src/value.ts"].mutants[0].coveredBy = [];
    const results = [uncovered, report("Killed")];
    const output = await runStrykerLadder({
      mutate: ["src/value.ts:4-4"],
      ladder: [
        { level: 1, tests: ["test/value.test.ts"] },
        { level: 2, tests: ["test/cli.test.ts"] },
      ],
      runLevel: async (request) => { calls.push(request); return { report: results.shift(), durationMs: 1 }; },
    });
    expect(calls.map((call) => call.level)).toEqual([1, 2]);
    expect(output.files["src/value.ts"].mutants[0]).toMatchObject({ status: "Killed", level: 2 });
  });

  it("keeps a covered timeout as detected", async () => {
    const calls = [];
    await runStrykerLadder({
      mutate: ["src/value.ts:4-4"],
      ladder: [{ level: 1, tests: ["a.test.ts"] }, { level: 2, tests: ["b.test.ts"] }],
      runLevel: async (request) => { calls.push(request); return { report: report("Timeout"), durationMs: 1 }; },
    });
    expect(calls).toHaveLength(1);
  });

  it("promotes all survivors of a level in one run", async () => {
    const calls = [];
    const two = report("Survived");
    const second = { ...two.files["src/value.ts"].mutants[0], id: "2", location: { start: { line: 6, column: 1 }, end: { line: 6, column: 5 } } };
    two.files["src/value.ts"].mutants.push(second);
    const promotedReport = structuredClone(two);
    promotedReport.files["src/value.ts"].mutants[0].status = "Killed";
    const results = [two, promotedReport, report("Survived")];
    const output = await runStrykerLadder({
      mutate: ["src/value.ts:4-6"],
      ladder: [
        { level: 0, tests: ["test/value.test.ts"] },
        { level: 1, tests: ["test/integration.test.ts"] },
      ],
      runLevel: async (request) => {
        calls.push(request);
        return { report: results.shift(), durationMs: 5 };
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].mutate).toEqual(["src/value.ts:4:1-4:7", "src/value.ts:6:0-6:4"]);
    expect(output.mutscope.levels.map((l) => l.mutants)).toEqual([2, 2]);
  });

  it("promotes only survivors with an exact location and stops once killed", async () => {
    const calls = [];
    const results = [report("Survived"), report("Killed", { testId: "99", testName: "integration kill" })];
    const output = await runStrykerLadder({
      mutate: ["src/value.ts:4-4"],
      ladder: [
        { level: 0, tests: ["test/value.test.ts"] },
        { level: 1, tests: ["test/integration.test.ts"] },
        { level: 2, tests: ["test/layer.test.ts"] },
        { level: 3, tests: ["test/all.test.ts"] },
      ],
      runLevel: async (request) => {
        calls.push(request);
        return { report: results.shift(), durationMs: calls.length * 10 };
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({
      level: 1,
      tests: ["test/integration.test.ts"],
      mutate: ["src/value.ts:4:1-4:7"],
    });
    const mutant = output.files["src/value.ts"].mutants[0];
    expect(mutant).toMatchObject({
      status: "Killed",
      level: 1,
      coveredBy: ["0", "1"],
      killedBy: ["1"],
      durationMsByLevel: { 0: null, 1: null },
    });
    expect(output.mutscope.levels).toHaveLength(2);
  });

  it("uses the recorded MTE report without running Stryker and drops StringLiteral", async () => {
    const fixture = JSON.parse(await readFile(path.join(here, "fixtures", "js", "nobail.json"), "utf8"));
    const output = await runStrykerLadder({
      mutate: ["scripts/cli/process/graph-rules.mjs:37-52"],
      ladder: [{ level: 0, tests: ["scripts/cli/process/plan-guard.test.mjs"] }],
      from: 0,
      to: 0,
      runLevel: async () => ({ report: fixture, durationMs: 123 }),
    });
    const mutants = output.files["scripts/cli/process/graph-rules.mjs"].mutants;
    expect(mutants.length).toBeGreaterThan(0);
    expect(mutants.every((mutant) => mutant.mutatorName !== "StringLiteral" && mutant.level === 0)).toBe(true);
    expect(output.schemaVersion).toBe("1.0");
  });

  it("converts one-based report columns to zero-based mutate selectors", () => {
    const mutant = report("Survived").files["src/value.ts"].mutants[0];
    expect(strykerMutantSelector("src\\value.ts", mutant)).toBe("src/value.ts:4:1-4:7");
    expect(() => strykerMutantSelector("x.ts", { id: "x" })).toThrow(/exact location/);
  });
});

describe("MTE report merge", () => {
  it("remaps colliding test ids by file and name", () => {
    const merged = mergeMutationReports([
      { level: 0, tests: ["a.test.ts"], durationMs: 2, report: report("Survived", { testId: "0", testName: "near" }) },
      { level: 1, tests: ["b.test.ts"], durationMs: 3, report: report("Killed", { testId: "0", testName: "far" }) },
    ]);
    expect(merged.testFiles["test/value.test.ts"].tests.map((test) => test.id)).toEqual(["0", "1"]);
    expect(merged.files["src/value.ts"].mutants[0]).toMatchObject({ coveredBy: ["0", "1"], killedBy: ["1"] });
  });
});

