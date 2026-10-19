import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildTestLadder, discoverTestLadder } from "./scope.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, "fixtures", "scope");

describe("JavaScript and TypeScript test ladder", () => {
  it("assigns neighbor, transitive importer, layer, and remaining tests", async () => {
    const levels = await discoverTestLadder({
      root: path.join(fixtures, "js"),
      changedFile: "src/board/item.ts",
    });

    expect(levels).toEqual([
      { level: 0, tests: ["src/board/item.test.ts"] },
      { level: 1, tests: ["tests/through-helper.test.ts"] },
      { level: 2, tests: ["src/board/sibling.test.ts"] },
      { level: 3, tests: ["tests/unrelated.test.ts"] },
    ]);
  });

  it("resolves extensionless index imports and CommonJS require", () => {
    const sources = {
      "src/value.js": "export const value = 1;",
      "src/index.js": "export { value } from './value.js';",
      "test/value.test.cjs": "require('../src');",
    };
    const levels = buildTestLadder({ changedFile: "src/value.js", sources });
    expect(levels[1].tests).toEqual(["test/value.test.cjs"]);
  });

  it("treats the project root as a valid layer", () => {
    const sources = {
      "value.js": "export const value = 1;",
      "sibling.test.js": "export const sibling = true;",
      "tests/unrelated.test.js": "export const unrelated = true;",
    };
    const levels = buildTestLadder({ changedFile: "value.js", sources });
    expect(levels[2].tests).toEqual(["sibling.test.js", "tests/unrelated.test.js"]);
    expect(levels[3].tests).toEqual([]);
  });
});

describe("Rust test ladder", () => {
  it("assigns adjacent and inline tests before module, crate, and workspace tests", async () => {
    const levels = await discoverTestLadder({
      root: path.join(fixtures, "rust"),
      changedFile: "crates/core/src/coverage.rs",
    });

    expect(levels).toEqual([
      { level: 0, tests: ["crates/core/src/coverage.rs", "crates/core/tests/coverage.rs"] },
      { level: 1, tests: ["crates/core/tests/public_api.rs"] },
      { level: 2, tests: ["crates/core/tests/other.rs"] },
      { level: 3, tests: ["crates/ui/tests/smoke.rs"] },
    ]);
  });
});

