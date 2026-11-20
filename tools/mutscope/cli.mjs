#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createCargoRunner, runCargoLadder } from "./cargo.mjs";
import { mutationRanges, strykerMutatePatterns } from "./diff.mjs";
import { mutationEntries } from "./report.mjs";
import { discoverTestLadder } from "./scope.mjs";
import { createStrykerRunner, createThreadQuarantine, runStrykerLadder } from "./stryker.mjs";

const execFileAsync = promisify(execFile);
const JS_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue"]);

export function usage() {
  return [
    "Usage: mutscope [options] [<base> [<head>]]",
    "",
    "Options:",
    "  --from <0..3>       first test-ladder level (default: 0)",
    "  --to <0..3>         last test-ladder level (default: 3)",
    "  --keep-strings      include StringLiteral mutants",
    "  --staged            use the staged diff (incompatible with revisions)",
    "  --diff-file <path>  read a recorded diff; use - for stdin",
    "  --output <path>     MTE JSON output (default: mutscope-report.json)",
    "  --json-summary      print the summary as JSON",
    "  -h, --help          show this help",
  ].join("\n");
}

function integer(value, flag) {
  if (!/^[0-3]$/.test(value ?? "")) throw new TypeError(`${flag} expects an integer from 0 to 3`);
  return Number(value);
}

export function parseCliArgs(argv) {
  const options = {
    from: 0, to: 3, keepStrings: false, staged: false,
    diffFile: null, output: "mutscope-report.json", jsonSummary: false, revisions: [], help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--from") options.from = integer(argv[++index], arg);
    else if (arg === "--to") options.to = integer(argv[++index], arg);
    else if (arg === "--output") options.output = argv[++index] ?? "";
    else if (arg === "--diff-file") options.diffFile = argv[++index] ?? "";
    else if (arg === "--keep-strings") options.keepStrings = true;
    else if (arg === "--staged") options.staged = true;
    else if (arg === "--json-summary") options.jsonSummary = true;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg.startsWith("-")) throw new TypeError(`Unknown option: ${arg}`);
    else options.revisions.push(arg);
  }
  if (options.from > options.to) throw new RangeError("--from must not exceed --to");
  if (!options.output) throw new TypeError("--output expects a path");
  if (options.diffFile === "") throw new TypeError("--diff-file expects a path or -");
  if (options.revisions.length > 2) throw new TypeError("Expected at most two revisions");
  if (options.staged && options.revisions.length) throw new TypeError("--staged cannot be combined with revisions");
  if (options.diffFile && (options.staged || options.revisions.length)) {
    throw new TypeError("--diff-file cannot be combined with --staged or revisions");
  }
  return options;
}

export async function gitDiff({ cwd = process.cwd(), revisions = [], staged = false } = {}) {
  const args = ["diff", "--no-ext-diff", "--unified=0"];
  if (staged) args.push("--cached");
  else if (revisions.length) args.push(...revisions);
  else args.push("HEAD");
  args.push("--");
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

function languageOf(file) {
  if (file.endsWith(".rs")) return "rust";
  if (JS_EXTENSIONS.has(path.posix.extname(file))) return "js";
  return null;
}

function testLookup(report) {
  return new Map(Object.entries(report.testFiles ?? {}).flatMap(([file, value]) =>
    (value.tests ?? []).map((test) => [String(test.id), { file, name: test.name }])));
}

function mutantSummary(entry) {
  return {
    file: entry.file,
    id: entry.mutant.id,
    mutatorName: entry.mutant.mutatorName,
    location: entry.mutant.location,
    level: entry.mutant.level,
  };
}

export function summarizeMutationReport(report) {
  const tests = testLookup(report);
  const entries = mutationEntries(report);
  const selectedIds = new Set(entries.flatMap(({ mutant }) => mutant.killedBy ?? []).map(String));
  const selectedTests = [...selectedIds].map((id) => tests.get(id) ?? { id, file: null, name: null });
  const survivedCovered = entries.filter(({ mutant }) => mutant.status === "Survived").map(mutantSummary);
  const survivedUncovered = entries.filter(({ mutant }) => mutant.status === "NoCoverage").map(mutantSummary);
  return {
    mutants: entries.length,
    killed: entries.filter(({ mutant }) => mutant.status === "Killed").length,
    selectedTests,
    survivedCovered,
    survivedUncovered,
  };
}

export function formatSummary(summary) {
  const lines = [
    `Mutants: ${summary.mutants}; killed: ${summary.killed}`,
    `Selected tests (killedBy): ${summary.selectedTests.length}`,
    ...summary.selectedTests.map((test) => `  ${test.file ?? "<unknown>"} :: ${test.name ?? test.id}`),
    `Survived with coverage: ${summary.survivedCovered.length}`,
    ...summary.survivedCovered.map((mutant) => `  ${mutant.file} :: ${mutant.id}`),
    `Survived without coverage: ${summary.survivedUncovered.length}`,
    ...summary.survivedUncovered.map((mutant) => `  ${mutant.file} :: ${mutant.id}`),
  ];
  return lines.join("\n");
}

export function summaryOutput(summary, report, json = false) {
  return json
    ? `${JSON.stringify({ ...summary, report }, null, 2)}\n`
    : `${formatSummary(summary)}\nReport: ${report}\n`;
}

export function combineChangeReports(changes) {
  const first = changes[0]?.report ?? {};
  const files = {};
  const testFiles = {};
  const testIds = new Map();
  let nextTestId = 0;
  const levels = [];
  const quarantined = [];
  const traces = [];

  for (const change of changes) {
    const localIds = new Map();
    for (const [file, value] of Object.entries(change.report.testFiles ?? {})) {
      for (const test of value.tests ?? []) {
        const identity = `${file}\0${test.name}`;
        if (!testIds.has(identity)) testIds.set(identity, String(nextTestId++));
        const id = testIds.get(identity);
        localIds.set(String(test.id), id);
        testFiles[file] ??= { source: value.source ?? "", tests: [] };
        if (!testFiles[file].tests.some((known) => known.id === id)) testFiles[file].tests.push({ ...test, id });
      }
    }
    for (const [file, value] of Object.entries(change.report.files ?? {})) {
      files[file] ??= { ...value, mutants: [] };
      for (const mutant of value.mutants ?? []) {
        const remap = (ids) => ids?.map((id) => localIds.get(String(id))).filter((id) => id !== undefined);
        const normalized = { ...mutant, coveredBy: remap(mutant.coveredBy) ?? [] };
        if (mutant.killedBy) normalized.killedBy = remap(mutant.killedBy);
        files[file].mutants.push(normalized);
      }
    }
    levels.push(...(change.report.mutscope?.levels ?? []).map((level) => ({ ...level, file: change.file })));
    quarantined.push(...(change.report.mutscope?.quarantined ?? []).map((entry) => ({ ...entry, changedFile: change.file })));
    traces.push(...(change.report.mutscope?.traces ?? []).map((entry) => ({ ...entry, file: change.file })));
  }
  return {
    ...first,
    files,
    testFiles,
    mutscope: {
      levels,
      quarantined,
      traces,
      changes: changes.map(({ file, language }) => ({ file, language })),
    },
  };
}

export async function runMutscope({
  cwd = process.cwd(), diff, from = 0, to = 3, keepStrings = false,
  discover = discoverTestLadder,
  runStryker = runStrykerLadder,
  runCargo = runCargoLadder,
  strykerRunner,
  cargoRunner,
  quarantine,
} = {}) {
  if (typeof diff !== "string") throw new TypeError("diff is required");
  const entries = mutationRanges(diff).map((entry) => ({ ...entry, language: languageOf(entry.file) }))
    .filter((entry) => entry.language);
  if (entries.length === 0) throw new TypeError("Diff has no changed JavaScript, TypeScript, Vue, or Rust lines");
  const changes = [];
  for (const entry of entries) {
    const ladder = await discover({ root: cwd, changedFile: entry.file, language: entry.language });
    const common = { mutate: [entry], ladder, from, to };
    const report = entry.language === "rust"
      ? await runCargo({ ...common, runLevel: cargoRunner ?? createCargoRunner({ cwd, keepStrings }) })
      : await runStryker({
        ...common,
        mutate: strykerMutatePatterns([entry]),
        keepStrings,
        cwd,
        runLevel: strykerRunner ?? createStrykerRunner({ cwd, keepStrings }),
        quarantine: quarantine ?? createThreadQuarantine({ cwd }),
      });
    changes.push({ file: entry.file, language: entry.language, report });
  }
  return combineChangeReports(changes);
}

async function stdinText() {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) value += chunk;
  return value;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const cwd = process.cwd();
  const diff = options.diffFile
    ? (options.diffFile === "-" ? await stdinText() : await readFile(path.resolve(cwd, options.diffFile), "utf8"))
    : await gitDiff({ cwd, revisions: options.revisions, staged: options.staged });
  const report = await runMutscope({ cwd, diff, from: options.from, to: options.to, keepStrings: options.keepStrings });
  const output = path.resolve(cwd, options.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const summary = summarizeMutationReport(report);
  process.stdout.write(summaryOutput(summary, output, options.jsonSummary));
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
