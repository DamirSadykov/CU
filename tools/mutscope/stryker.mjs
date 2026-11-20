import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mergeMutationReports, mutationEntries, mutationIdentity } from "./report.mjs";

const ESCALATING_STATUSES = new Set(["Survived", "NoCoverage"]);
const escalates = (mutant) => ESCALATING_STATUSES.has(mutant.status)
  || (mutant.status === "Timeout" && !(mutant.coveredBy?.length > 0));
const FAILED_DRY_RUN = /There were failed tests in the initial test run/;
const ANSI = /\u001b\[[0-9;]*m/g;

export function failedDryRunTests(output) {
  const lines = output.replace(ANSI, "").split(/\r?\n/);
  const start = lines.findIndex((line) => /One or more tests failed in the initial test run/.test(line));
  if (start < 0) return [];
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("\t")) break;
    if (!line.startsWith("\t\t")) names.push(line.slice(1).trim());
  }
  return names;
}

function testTitles(source) {
  const titles = { suites: [], tests: [] };
  const pattern = /\b(describe|suite|it|test)(?:\.\w+)*\s*\(\s*(["'`])((?:\\.|(?!\2).)*)\2/g;
  for (const match of source.matchAll(pattern)) {
    (match[1] === "describe" || match[1] === "suite" ? titles.suites : titles.tests).push(match[3]);
  }
  return titles;
}

export function filesOfFailedTests(names, sources) {
  const files = new Set();
  for (const name of names) {
    for (const [file, source] of sources) {
      const { suites, tests } = testTitles(source);
      const owns = tests.some((title) => name === title
        || (name.endsWith(` ${title}`) && suites.some((suite) => name.startsWith(`${suite} `))));
      if (owns) files.add(file);
    }
  }
  return [...files];
}
const require = createRequire(import.meta.url);
const localStryker = () => path.join(
  path.dirname(require.resolve("@stryker-mutator/core/package.json")),
  "bin",
  "stryker.js",
);

export function strykerMutantSelector(file, mutant) {
  const { start, end } = mutant.location ?? {};
  if (![start?.line, start?.column, end?.line, end?.column].every(Number.isInteger)) {
    throw new TypeError(`Mutant ${mutant.id ?? "<unknown>"} has no exact location`);
  }
  return `${file.replaceAll("\\", "/")}:${start.line}:${start.column - 1}-${end.line}:${end.column - 1}`;
}

export function gitIgnoredPatterns(cwd) {
  const output = execFileSync("git", ["ls-files", "-oi", "--exclude-standard", "--directory"], {
    cwd, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .filter((line) => !line.split("/").includes("node_modules"))
    .map((line) => `/${line.replace(/\/$/, "")}`);
}

export function envSetupSource(vitestEntry, { coverageRoot, childHook = new URL("./child-coverage.mjs", import.meta.url).href } = {}) {
  return [
    `import { afterEach, beforeEach } from ${JSON.stringify(pathToFileURL(vitestEntry).href)};`,
    'import { readdirSync, readFileSync, rmSync } from "node:fs";',
    'import { randomUUID } from "node:crypto";',
    'import path from "node:path";',
    `const coverageRoot = ${JSON.stringify(coverageRoot ?? "")};`,
    `const childImport = ${JSON.stringify(`--import=${childHook}`)};`,
    "const baseOptions = process.env.NODE_OPTIONS ?? \"\";",
    "let childDirectory;",
    "beforeEach(() => {",
    "  const ns = globalThis.__stryker__;",
    "  const active = ns?.activeMutant;",
    "  if (active === undefined) delete process.env.__STRYKER_ACTIVE_MUTANT__;",
    "  else process.env.__STRYKER_ACTIVE_MUTANT__ = String(active);",
    "  childDirectory = coverageRoot && active === undefined && ns?.currentTestId !== undefined",
    "    ? path.join(coverageRoot, randomUUID()) : undefined;",
    "  if (!childDirectory) return;",
    "  process.env.MUTSCOPE_CHILD_COVERAGE = childDirectory;",
    "  process.env.NODE_OPTIONS = [baseOptions, childImport].filter(Boolean).join(\" \");",
    "});",
    "afterEach(() => {",
    "  if (!childDirectory) return;",
    "  const directory = childDirectory;",
    "  childDirectory = undefined;",
    "  delete process.env.MUTSCOPE_CHILD_COVERAGE;",
    "  process.env.NODE_OPTIONS = baseOptions;",
    "  if (!baseOptions) delete process.env.NODE_OPTIONS;",
    "  const ns = globalThis.__stryker__;",
    "  let files = [];",
    "  try { files = readdirSync(directory); } catch { return; }",
    "  const coverage = ns.mutantCoverage ??= { static: {}, perTest: {} };",
    "  const hits = coverage.perTest[ns.currentTestId] ??= {};",
    "  for (const file of files) {",
    "    const child = JSON.parse(readFileSync(path.join(directory, file), \"utf8\"));",
    "    for (const [id, count] of Object.entries(child)) hits[id] = (hits[id] ?? 0) + count;",
    "  }",
    "  rmSync(directory, { recursive: true, force: true });",
    "});",
    "",
  ].join("\n");
}

export function vitestConfigSource({ tests, baseConfigFile, setupFile }) {
  const include = JSON.stringify(tests.map((test) => test.replaceAll("\\", "/")));
  const setup = setupFile ? JSON.stringify(setupFile.replaceAll("\\", "/")) : "";
  if (!baseConfigFile) return `export default { root: process.cwd(), test: { include: ${include}, setupFiles: [${setup}] } };\n`;
  const base = JSON.stringify(pathToFileURL(baseConfigFile).href);
  return [
    `import base from ${base};`,
    `const config = typeof base === "function" ? await base({ command: "serve", mode: "test" }) : base;`,
    `export default { ...config, root: process.cwd(), test: { ...config.test, include: ${include}, setupFiles: [...[config.test?.setupFiles ?? []].flat(), ${setup}] } };`,
    "",
  ].join("\n");
}

export function buildStrykerConfig({
  baseConfig = {}, mutate, reportFile, vitestConfigFile, ignorePatterns = [], keepStrings = false, traceFile,
}) {
  const excluded = new Set(baseConfig.mutator?.excludedMutations ?? []);
  if (!keepStrings) excluded.add("StringLiteral");
  const trace = traceFile ? {
    appendPlugins: [...(baseConfig.appendPlugins ?? []), fileURLToPath(new URL("./trace-reporter.mjs", import.meta.url))],
    mutscopeTrace: traceFile,
  } : {};
  return {
    ...baseConfig,
    ...trace,
    testRunner: "vitest",
    vitest: { ...baseConfig.vitest, configFile: vitestConfigFile, related: false },
    ignorePatterns: [...new Set([...(baseConfig.ignorePatterns ?? []), ...ignorePatterns])],
    mutate,
    disableBail: true,
    coverageAnalysis: "perTest",
    allowEmpty: true,
    reporters: traceFile ? ["json", "mutscope-trace"] : ["json"],
    jsonReporter: { fileName: reportFile },
    mutator: { ...baseConfig.mutator, excludedMutations: [...excluded] },
  };
}

function execute(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const started = performance.now();
    const log = [];
    let stdout = "";
    let stderr = "";
    const collect = (chunk) => {
      const t = Math.round(performance.now() - started);
      for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) log.push({ t, line: line.trim() });
    };
    child.stdout.on("data", (chunk) => { stdout += chunk; collect(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk; collect(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, log }));
  });
}

const STRYKER_PHASES = [
  ["sandbox", /Creating .*sandbox|Copying files/i],
  ["instrumented", /Instrumented \d+ source file/i],
  ["dryRunStart", /Starting initial test run/i],
  ["dryRunDone", /Initial test run succeeded/i],
  ["mutantsStart", /mutants? are going to be tested|Starting mutation testing/i],
  ["done", /Done in /i],
];

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function summarizeTrace(events, log = []) {
  const at = (name) => events.find((entry) => entry.event === name)?.t ?? null;
  const dryRun = events.find((entry) => entry.event === "dryRun");
  const plans = events.find((entry) => entry.event === "plan")?.mutants ?? [];
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const tested = events.filter((entry) => entry.event === "mutant");
  const byStatus = {};
  let previous = at("plan") ?? tested[0]?.t ?? 0;
  for (const entry of tested) {
    const bucket = byStatus[entry.status] ??= { count: 0, gapMs: 0 };
    bucket.count += 1;
    bucket.gapMs += entry.t - previous;
    previous = entry.t;
  }
  const timeouts = plans.filter((plan) => plan.timeoutMs != null).map((plan) => plan.timeoutMs);
  return {
    stryker: Object.fromEntries(STRYKER_PHASES.map(([name, pattern]) => [
      name, log.find((entry) => pattern.test(entry.line))?.t ?? null,
    ])),
    reporter: { created: at("created"), dryRun: at("dryRun"), plan: at("plan"), report: at("report"), wrapUp: at("wrapUp") },
    concurrency: events.find((entry) => entry.event === "created")?.concurrency ?? null,
    dryRun: dryRun ? {
      netMs: dryRun.net,
      overheadMs: dryRun.overhead,
      tests: dryRun.tests.length,
      slowest: [...dryRun.tests].sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)).slice(0, 5),
    } : null,
    plan: {
      run: plans.filter((plan) => plan.plan === "Run").length,
      early: plans.filter((plan) => plan.plan !== "Run").length,
      timeoutMs: { median: median(timeouts), max: timeouts.length ? Math.max(...timeouts) : null },
      netMs: plans.reduce((sum, plan) => sum + (plan.netMs ?? 0), 0),
    },
    mutants: {
      firstMs: tested[0]?.t ?? null,
      lastMs: tested.at(-1)?.t ?? null,
      byStatus,
      timeouts: tested.filter((entry) => entry.status === "Timeout").map((entry) => planById.get(entry.id) ?? { id: entry.id }),
    },
    log: log.filter((entry) => /\bINFO\b|\bWARN\b|\bERROR\b/.test(entry.line)),
  };
}

export function createStrykerRunner({
  cwd = process.cwd(), baseConfig = {}, keepStrings = false,
  command = process.execPath, commandPrefix, runCommand = execute,
  ignorePatterns = gitIgnoredPatterns(cwd),
  baseVitestConfig = ["vite.config.ts", "vitest.config.ts", "vite.config.mjs", "vitest.config.mjs"]
    .map((name) => path.join(cwd, name)).find((file) => existsSync(file)),
  vitestEntry = () => {
    const manifest = createRequire(path.join(cwd, "package.json")).resolve("vitest/package.json");
    const entry = JSON.parse(readFileSync(manifest, "utf8")).exports["."];
    return path.join(path.dirname(manifest), entry.import?.default ?? entry.import ?? entry.default);
  },
} = {}) {
  return async ({ mutate, tests }) => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "mutscope-stryker-"));
    const configFile = path.join(temporary, "stryker.conf.json");
    const reportFile = path.join(temporary, "report.json");
    const vitestConfigFile = path.join(temporary, "vitest.config.mjs");
    const setupFile = path.join(temporary, "env-mutant-setup.mjs");
    const traceFile = path.join(temporary, "trace.jsonl");
    const coverageRoot = path.join(temporary, "child-coverage");
    await writeFile(setupFile, envSetupSource(vitestEntry(), { coverageRoot }), "utf8");
    await writeFile(vitestConfigFile, vitestConfigSource({ tests, baseConfigFile: baseVitestConfig, setupFile }), "utf8");
    const config = buildStrykerConfig({
      baseConfig, mutate, reportFile, vitestConfigFile, ignorePatterns, keepStrings, traceFile,
    });
    await writeFile(configFile, JSON.stringify(config), "utf8");
    const started = performance.now();
    try {
      const prefix = commandPrefix ?? [localStryker()];
      const result = await runCommand(command, [...prefix, "run", configFile], cwd);
      const durationMs = Math.round(performance.now() - started);
      if (result.code !== 0) {
        const output = [result.stdout, result.stderr].join("\n");
        const tail = output.trim().split(/\r?\n/).slice(-80).join("\n");
        const error = new Error(`Stryker exited with ${result.code}:\n${tail}`);
        if (FAILED_DRY_RUN.test(output)) error.failedTests = failedDryRunTests(output);
        throw error;
      }
      const events = (await readFile(traceFile, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
      return {
        report: JSON.parse(await readFile(reportFile, "utf8")),
        durationMs,
        trace: summarizeTrace(events, result.log ?? []),
      };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  };
}

function withoutStrings(report, keepStrings) {
  if (keepStrings) return report;
  return {
    ...report,
    files: Object.fromEntries(Object.entries(report.files ?? {}).map(([file, value]) => [file, {
      ...value,
      mutants: (value.mutants ?? []).filter((mutant) => mutant.mutatorName !== "StringLiteral"),
    }])),
  };
}

function onlyMutants(report, wanted) {
  const identities = new Set(wanted.map((entry) => mutationIdentity(entry.file, entry.mutant)));
  return {
    ...report,
    files: Object.fromEntries(Object.entries(report.files ?? {}).map(([file, value]) => [file, {
      ...value,
      mutants: (value.mutants ?? []).filter((mutant) => identities.has(mutationIdentity(file, mutant))),
    }])),
  };
}

export function failedVitestFiles(output, cwd) {
  return (output.testResults ?? []).filter((result) => result.status !== "passed")
    .map((result) => path.relative(cwd, result.name).replaceAll("\\", "/"));
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function createThreadQuarantine({
  cwd = process.cwd(), command = process.execPath, runCommand = execute,
  vitestBin = () => path.join(path.dirname(createRequire(path.join(cwd, "package.json")).resolve("vitest/package.json")), "vitest.mjs"),
  baseVitestConfig = ["vite.config.ts", "vitest.config.ts", "vite.config.mjs", "vitest.config.mjs"]
    .map((name) => path.join(cwd, name)).find((file) => existsSync(file)),
  cacheFile = path.join(cwd, "node_modules", ".cache", "mutscope", "threads.json"),
} = {}) {
  return async (tests) => {
    const cache = await readJson(cacheFile, {});
    const hashes = Object.fromEntries(await Promise.all(tests.map(async (test) => [
      test, createHash("sha256").update(await readFile(path.join(cwd, test))).digest("hex"),
    ])));
    const unknown = tests.filter((test) => cache[test]?.hash !== hashes[test]);
    if (unknown.length > 0) {
      const temporary = await mkdtemp(path.join(os.tmpdir(), "mutscope-threads-"));
      const configFile = path.join(temporary, "vitest.config.mjs");
      const outputFile = path.join(temporary, "result.json");
      try {
        await writeFile(configFile, vitestConfigSource({ tests: unknown, baseConfigFile: baseVitestConfig }), "utf8");
        const result = await runCommand(command, [
          vitestBin(), "run", "--config", configFile, "--pool", "threads", "--maxWorkers", "1",
          "--reporter", "json", "--outputFile", outputFile,
        ], cwd);
        const output = await readJson(outputFile, null);
        if (!output) {
          const tail = [result.stdout, result.stderr].join("\n").trim().split(/\r?\n/).slice(-40).join("\n");
          throw new Error(`vitest thread probe exited with ${result.code}:\n${tail}`);
        }
        const failed = new Set(failedVitestFiles(output, cwd));
        for (const test of unknown) cache[test] = { hash: hashes[test], threads: !failed.has(test.replaceAll("\\", "/")) };
        await mkdir(path.dirname(cacheFile), { recursive: true });
        await writeFile(cacheFile, JSON.stringify(cache, null, 2), "utf8");
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
    return {
      tests: tests.filter((test) => cache[test].threads),
      skipped: tests.filter((test) => !cache[test].threads),
    };
  };
}

export async function runStrykerLadder({
  mutate, ladder, from = 0, to = 3, keepStrings = false, runLevel, quarantine,
  cwd = process.cwd(), readSource = (file) => readFile(path.join(cwd, file), "utf8"), maxDryRunFailures = 3,
}) {
  if (typeof runLevel !== "function") throw new TypeError("runLevel is required");
  if (!Array.isArray(mutate) || mutate.length === 0) throw new TypeError("mutate must contain changed ranges");
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > 3 || from > to) {
    throw new RangeError("Expected 0 <= from <= to <= 3");
  }
  const selected = ladder.filter(({ level, tests }) => level >= from && level <= to && tests.length > 0);
  if (selected.length === 0) throw new TypeError(`Ladder has no tests between levels ${from} and ${to}`);

  const runs = [];
  const quarantined = [];
  const traces = [];
  let survivors = null;
  for (const level of selected) {
    const probeStarted = performance.now();
    const probed = quarantine ? await quarantine(level.tests) : { tests: level.tests };
    const probeMs = quarantine ? Math.round(performance.now() - probeStarted) : 0;
    quarantined.push(...(probed.skipped ?? []).map((file) => ({ level: level.level, file, reason: "threads" })));
    let tests = probed.tests;
    const request = survivors === null
      ? { level: level.level, mutate, mutants: null }
      : {
        level: level.level,
        mutate: survivors.map((entry) => strykerMutantSelector(entry.file, entry.mutant)),
        mutants: survivors.map((entry) => entry.mutant),
      };
    let result = null;
    let dryRunFailures = 0;
    while (tests.length > 0) {
      try {
        result = await runLevel({ ...request, tests });
        break;
      } catch (error) {
        if (!error.failedTests?.length || dryRunFailures >= maxDryRunFailures) throw error;
        const sources = await Promise.all(tests.map(async (test) => [test, await readSource(test)]));
        const failing = filesOfFailedTests(error.failedTests, sources);
        if (failing.length === 0) throw error;
        dryRunFailures += 1;
        quarantined.push(...failing.map((file) => ({ level: level.level, file, reason: "dryRun", tests: error.failedTests })));
        tests = tests.filter((test) => !failing.includes(test));
      }
    }
    if (result === null) {
      traces.push({ level: level.level, probeMs, skipped: true });
      continue;
    }
    result.report = survivors === null
      ? withoutStrings(result.report, keepStrings)
      : onlyMutants(withoutStrings(result.report, keepStrings), survivors);
    runs.push({ ...result, level: level.level, tests });
    traces.push({ level: level.level, probeMs, dryRunFailures, strykerMs: result.durationMs ?? null, ...result.trace });
    survivors = mutationEntries(result.report).filter(({ mutant }) => escalates(mutant));
    if (survivors.length === 0) break;
  }
  if (runs.length === 0) throw new TypeError(`Every test between levels ${from} and ${to} is quarantined`);
  const merged = mergeMutationReports(runs);
  merged.mutscope.quarantined = quarantined;
  merged.mutscope.traces = traces;
  return merged;
}

export const runStryker = runStrykerLadder;

