import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { jsTsDiff, runMutationGate } from "./mutation-gate.mjs";

function fakeMutscope(source) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mutation-gate-mutscope-"));
  writeFileSync(path.join(directory, "stryker.mjs"), "// availability marker; Stryker is deliberately not installed\n");
  writeFileSync(path.join(directory, "cli.mjs"), source);
  return directory;
}

const mixedDiff = [
  "diff --git a/src/value.ts b/src/value.ts",
  "--- a/src/value.ts",
  "+++ b/src/value.ts",
  "@@ -1 +1 @@",
  "-export const value = 1;",
  "+export const value = 2;",
  "diff --git a/docs/note.md b/docs/note.md",
  "--- a/docs/note.md",
  "+++ b/docs/note.md",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

describe("runMutationGate", () => {
  it("loads one fake mutscope call and returns the common mutation format", async () => {
    const directory = fakeMutscope(`
      export async function runMutscope(options) {
        globalThis.__mutationGateCalls = [...(globalThis.__mutationGateCalls ?? []), options];
        return {
          files: { "src/value.ts": { mutants: [
            { status: "Killed", mutatorName: "BooleanLiteral", replacement: "false", location: { start: { line: 2, column: 4 }, end: { line: 2, column: 8 } } },
            { status: "Survived", mutatorName: "ArithmeticOperator", replacement: "-", location: { start: { line: 3, column: 6 }, end: { line: 3, column: 7 } } },
            { status: "NoCoverage", mutatorName: "StringLiteral", replacement: "empty", location: { start: { line: 4, column: 2 }, end: { line: 4, column: 7 } } }
          ] } },
          mutscope: { levels: [{ level: 0 }, { level: 1 }], quarantined: [{ level: 1, file: "src/value.test.ts", reason: "threads" }] }
        };
      }
    `);
    delete globalThis.__mutationGateCalls;
    const result = await runMutationGate({
      task: { step_base: "base-sha" }, cwd: process.cwd(), mutscopeDir: directory,
      maxLevel: 1, readDiff: () => mixedDiff,
    });

    expect(globalThis.__mutationGateCalls).toHaveLength(1);
    expect(globalThis.__mutationGateCalls[0]).toMatchObject({ cwd: process.cwd(), from: 0, to: 1 });
    expect(globalThis.__mutationGateCalls[0].diff).toContain("src/value.ts");
    expect(globalThis.__mutationGateCalls[0].diff).not.toContain("docs/note.md");
    expect(result).toMatchObject({ status: "pass", reason: null, levels: [0, 1], killed: 1 });
    expect(result.survived).toEqual([{
      file: "src/value.ts", line: 3, column: 6, mutator: "ArithmeticOperator", replacement: "-",
      selector: "src/value.ts:3:5-3:6",
    }]);
    expect(result.noCoverage).toHaveLength(1);
    expect(result.quarantined).toHaveLength(1);
    expect(result.duration_ms).toEqual(expect.any(Number));
  });

  it("returns cannot after the explicit timeout when fake mutscope never settles", async () => {
    const directory = fakeMutscope("export function runMutscope() { return new Promise(() => {}); }\n");
    const started = Date.now();
    const result = await runMutationGate({
      task: { step_base: "base-sha" }, cwd: process.cwd(), mutscopeDir: directory,
      timeoutMs: 50, readDiff: () => mixedDiff,
    });
    expect(result).toMatchObject({ status: "cannot", reason: expect.stringMatching(/timed out after 50ms/) });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("skips an unconfigured or invalid mutscope directory", async () => {
    const missing = mkdtempSync(path.join(os.tmpdir(), "mutation-gate-missing-"));
    expect(await runMutationGate({ task: { step_base: "base" }, mutscopeDir: "" })).toMatchObject({ status: "skipped", reason: expect.stringMatching(/not configured/) });
    expect(await runMutationGate({ task: { step_base: "base" }, mutscopeDir: missing })).toMatchObject({ status: "skipped", reason: expect.stringMatching(/stryker\.mjs/) });
  });

  it("skips a diff without JavaScript or TypeScript changes without importing mutscope", async () => {
    const directory = fakeMutscope("throw new Error('must not import');\n");
    const result = await runMutationGate({
      task: { step_base: "base" }, mutscopeDir: directory,
      readDiff: () => mixedDiff.slice(mixedDiff.indexOf("diff --git a/docs")),
    });
    expect(result).toMatchObject({ status: "skipped", reason: expect.stringMatching(/no changed JavaScript or TypeScript/) });
  });

  it("returns cannot for a missing step base and for mutscope failures", async () => {
    const directory = fakeMutscope("export function runMutscope() { throw new Error('Stryker failed'); }\n");
    expect(await runMutationGate({ task: {}, mutscopeDir: directory })).toMatchObject({ status: "cannot", reason: expect.stringMatching(/step_base/) });
    expect(await runMutationGate({
      task: { step_base: "base" }, mutscopeDir: directory, readDiff: () => mixedDiff,
    })).toMatchObject({ status: "cannot", reason: expect.stringMatching(/Stryker failed/) });
  });
});

describe("jsTsDiff", () => {
  it("keeps JS and TS patches and drops other file types", () => {
    const filtered = jsTsDiff(mixedDiff);
    expect(filtered).toContain("src/value.ts");
    expect(filtered).not.toContain("docs/note.md");
  });
});
