import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_STEP_TIMEOUT_MS } from "./run-step.mjs";

const JS_TS_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const slash = (file) => String(file ?? "").replaceAll("\\", "/");

function diffPath(block) {
  const marker = block.match(/^\+\+\+ (.+)$/m)?.[1]?.trim();
  if (!marker || marker === "/dev/null") return null;
  let file = marker;
  if (file.startsWith('"') && file.endsWith('"')) {
    try { file = JSON.parse(file); } catch {}
  }
  return slash(file).replace(/^b\//, "");
}

export function jsTsDiff(diff = "") {
  return String(diff).split(/(?=^diff --git )/m)
    .filter((block) => {
      const file = diffPath(block);
      return file && JS_TS_EXTENSIONS.has(path.posix.extname(file).toLowerCase());
    })
    .join("");
}

function gitStepDiff(cwd, base) {
  return execFileSync("git", ["diff", "--no-renames", "--no-ext-diff", "--unified=0", base, "--"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function selector(file, mutant) {
  const { start, end } = mutant?.location ?? {};
  if (![start?.line, start?.column, end?.line, end?.column].every(Number.isInteger)) return null;
  return `${slash(file)}:${start.line}:${start.column - 1}-${end.line}:${end.column - 1}`;
}

function mutationFact(file, mutant) {
  return {
    file: slash(file),
    line: mutant?.location?.start?.line ?? null,
    column: mutant?.location?.start?.column ?? null,
    mutator: mutant?.mutatorName ?? null,
    replacement: mutant?.replacement ?? null,
    selector: selector(file, mutant),
  };
}

function reportEntries(report) {
  return Object.entries(report?.files ?? {}).flatMap(([file, value]) =>
    (Array.isArray(value?.mutants) ? value.mutants : []).map((mutant) => ({ file, mutant })));
}

export function mutationResult(report, durationMs) {
  const entries = reportEntries(report);
  const byStatus = (status) => entries
    .filter(({ mutant }) => mutant?.status === status)
    .map(({ file, mutant }) => mutationFact(file, mutant));
  const levels = [...new Set((report?.mutscope?.levels ?? [])
    .map((level) => level?.level)
    .filter(Number.isInteger))].sort((a, b) => a - b);
  return {
    levels,
    killed: entries.filter(({ mutant }) => mutant?.status === "Killed").length,
    survived: byStatus("Survived"),
    noCoverage: byStatus("NoCoverage"),
    quarantined: Array.isArray(report?.mutscope?.quarantined) ? report.mutscope.quarantined : [],
    duration_ms: durationMs,
    status: "pass",
    reason: null,
  };
}

function emptyResult(status, durationMs, reason) {
  return {
    levels: [], killed: 0, survived: [], noCoverage: [], quarantined: [],
    duration_ms: durationMs, status, reason,
  };
}

async function withinTimeout(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`mutation gate timed out after ${timeoutMs}ms`);
          error.code = "ETIMEDOUT";
          reject(error);
        }, Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runMutationGate({
  task,
  cwd = process.cwd(),
  mutscopeDir,
  maxLevel = 1,
  timeoutMs,
  readDiff = gitStepDiff,
} = {}) {
  const started = Date.now();
  const finish = (status, reason) => emptyResult(status, Date.now() - started, reason);
  const directory = typeof mutscopeDir === "string" ? mutscopeDir.trim() : "";
  if (!directory) return finish("skipped", "mutscope directory is not configured");
  const strykerModule = path.join(directory, "stryker.mjs");
  if (!fs.existsSync(strykerModule)) return finish("skipped", `mutscope is unavailable: ${strykerModule} does not exist`);
  if (!task?.step_base) return finish("cannot", "mutation gate requires step_base recorded before the step ran");

  try {
    const diff = jsTsDiff(await readDiff(cwd, task.step_base));
    if (!diff.trim()) return finish("skipped", "step diff has no changed JavaScript or TypeScript lines");
    const cliModule = path.join(directory, "cli.mjs");
    const loaded = await import(pathToFileURL(cliModule).href);
    if (typeof loaded.runMutscope !== "function") {
      return finish("cannot", `mutscope module does not export runMutscope: ${cliModule}`);
    }
    const limit = timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    const report = await withinTimeout(loaded.runMutscope({ cwd, diff, from: 0, to: maxLevel }), limit);
    return mutationResult(report, Date.now() - started);
  } catch (error) {
    const message = (error && error.message) || String(error);
    return finish("cannot", error?.code === "ETIMEDOUT" ? message : `mutation gate cannot run: ${message}`);
  }
}
