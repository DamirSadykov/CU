import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mutationRanges } from "./diff.mjs";
import { mergeMutationReports, mutationEntries } from "./report.mjs";

const STATUS = {
  CaughtMutant: "Killed",
  MissedMutant: "Survived",
  Timeout: "Timeout",
  Unviable: "CompileError",
};

const slash = (value) => value.replaceAll("\\", "/").replace(/^\.\//, "");
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function cargoDiffSelector(diffOrEntries) {
  const entries = typeof diffOrEntries === "string" ? mutationRanges(diffOrEntries) : diffOrEntries;
  const alternatives = entries.flatMap(({ file, ranges }) => ranges.map(({ startLine, endLine }) => {
    const lines = Array.from({ length: endLine - startLine + 1 }, (_, index) => startLine + index);
    return `${escapeRegex(slash(file))}:(?:${lines.join("|")}):`;
  }));
  return alternatives.length ? `^(?:${alternatives.join("|")})` : "(?!)";
}

export function cargoMutantSelector(mutants) {
  const names = mutants.map((entry) => typeof entry === "string" ? entry : entry.name ?? entry.id);
  if (names.some((name) => !name)) throw new TypeError("Every cargo mutant needs a name");
  return names.length ? `^(?:${names.map(escapeRegex).join("|")})$` : "(?!)";
}

function testTarget(file) {
  const normalized = slash(file);
  const match = /(?:^|\/)tests\/([^/]+)\.rs$/.exec(normalized);
  return match?.[1] ?? null;
}

export function cargoTestArgs(tests) {
  const args = [];
  let needsLib = false;
  let needsBins = false;
  const targets = new Set();
  for (const file of tests) {
    const target = testTarget(file);
    if (target) targets.add(target);
    else if (/(?:^|\/)src\/(?:main|bin\/[^/]+|bin\/[^/]+\/main)\.rs$/.test(slash(file))) needsBins = true;
    else if (/\.rs$/.test(file)) needsLib = true;
  }
  if (needsBins) args.unshift("--bins");
  if (needsLib) args.unshift("--lib");
  for (const target of targets) args.push("--test", target);
  return args;
}

function integrationFile(tests, target) {
  return tests.find((file) => testTarget(file) === target);
}

function binaryTarget(line) {
  const quoted = /Running\s+`([^`]+)`/.exec(line)?.[1];
  if (!quoted) return null;
  const executable = quoted.trim().split(/\s+/)[0].replace(/^"|"$/g, "");
  return path.basename(executable).replace(/\.exe$/i, "").replace(/-[0-9a-f]{8,}$/i, "");
}

export function cargoFailedTests(log, tests = []) {
  const failures = [];
  let target = null;
  for (const line of log.split(/\r?\n/)) {
    target = binaryTarget(line) ?? target;
    const failed = /^test (.+) \.\.\. FAILED\s*$/.exec(line.trim());
    if (!failed) continue;
    const file = integrationFile(tests, target)
      ?? (tests.length === 1 ? tests[0] : tests.find((candidate) => !testTarget(candidate)))
      ?? `<cargo:${target ?? "unknown"}>`;
    failures.push({ file: slash(file), name: failed[1] });
  }
  return failures.filter((failure, index) => failures.findIndex((item) =>
    item.file === failure.file && item.name === failure.name) === index);
}

function phaseDuration(outcome) {
  return Math.round((outcome.phase_results ?? []).reduce((sum, phase) => sum + (phase.duration ?? 0), 0) * 1000);
}

export async function cargoOutcomesToMte(outcomes, {
  directory = ".", tests = [], readText = (file) => readFile(file, "utf8"), keepStrings = false,
} = {}) {
  const records = outcomes.outcomes ?? [];
  const mutantRecords = records.filter((record) => record.scenario?.Mutant);
  const included = keepStrings
    ? mutantRecords
    : mutantRecords.filter((record) => record.scenario.Mutant.genre !== "StringLiteral");
  const failures = new Map();
  for (const record of included) {
    const log = record.log_path
      ? await readText(path.join(directory, record.log_path)).catch(() => "")
      : "";
    failures.set(record.scenario.Mutant.name, cargoFailedTests(log, tests));
  }

  const testIds = new Map();
  for (const entries of failures.values()) for (const test of entries) {
    const key = `${test.file}\0${test.name}`;
    if (!testIds.has(key)) testIds.set(key, String(testIds.size));
  }
  const files = {};
  for (const record of included) {
    const cargo = record.scenario.Mutant;
    const file = slash(cargo.file);
    const killedBy = (failures.get(cargo.name) ?? []).map((test) => testIds.get(`${test.file}\0${test.name}`));
    const mutant = {
      id: cargo.name,
      mutatorName: cargo.genre,
      replacement: cargo.replacement,
      description: cargo.name,
      location: cargo.span,
      status: STATUS[record.summary] ?? "RuntimeError",
      duration: phaseDuration(record),
      coveredBy: killedBy,
    };
    if (mutant.status === "Killed") mutant.killedBy = killedBy;
    files[file] ??= { language: "rust", source: "", mutants: [] };
    files[file].mutants.push(mutant);
  }
  const testFiles = {};
  for (const [key, id] of testIds) {
    const [file, name] = key.split("\0");
    testFiles[file] ??= { source: "", tests: [] };
    testFiles[file].tests.push({ id, name });
  }
  return {
    schemaVersion: "1.0",
    thresholds: { high: 80, low: 60 },
    projectRoot: "",
    files,
    testFiles,
    framework: { name: "cargo-mutants", version: outcomes.cargo_mutants_version ?? "unknown" },
  };
}

function execute(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export function createCargoRunner({
  cwd = process.cwd(), command = "cargo", runCommand = execute, keepStrings = false,
} = {}) {
  return async ({ selector, tests }) => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "mutscope-cargo-"));
    const args = ["mutants", "--output", temporary, "--colors", "never", "--re", selector];
    if (!keepStrings) args.push("--exclude-re", 'replace .+ with "xyzzy"');
    args.push("--", ...cargoTestArgs(tests), "--no-fail-fast");
    const started = performance.now();
    try {
      const result = await runCommand(command, args, cwd);
      const outputDirectory = path.join(temporary, "mutants.out");
      let outcomes;
      try {
        outcomes = JSON.parse(await readFile(path.join(outputDirectory, "outcomes.json"), "utf8"));
      } catch (error) {
        const tail = [result.stdout, result.stderr].join("\n").trim().split(/\r?\n/).slice(-80).join("\n");
        throw new Error(`cargo-mutants exited with ${result.code} without outcomes.json:\n${tail}`, { cause: error });
      }
      return {
        report: await cargoOutcomesToMte(outcomes, { directory: outputDirectory, tests, keepStrings }),
        durationMs: Math.round(performance.now() - started),
      };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  };
}

export async function runCargoLadder({
  mutate, ladder, from = 0, to = 3, runLevel = createCargoRunner(),
}) {
  const selected = ladder.filter((entry) => entry.level >= from && entry.level <= to && entry.tests.length > 0);
  if (selected.length === 0) throw new TypeError(`Ladder has no tests between levels ${from} and ${to}`);
  const runs = [];
  let survivors = null;
  for (const level of selected) {
    const selector = survivors === null
      ? cargoDiffSelector(mutate)
      : cargoMutantSelector(survivors.map(({ mutant }) => mutant.id));
    const result = await runLevel({ level: level.level, selector, tests: level.tests, mutants: survivors });
    runs.push({ ...result, level: level.level, tests: level.tests });
    survivors = mutationEntries(result.report).filter(({ mutant }) => mutant.status === "Survived" || mutant.status === "NoCoverage");
    if (survivors.length === 0) break;
  }
  return mergeMutationReports(runs);
}

export const runCargo = runCargoLadder;
