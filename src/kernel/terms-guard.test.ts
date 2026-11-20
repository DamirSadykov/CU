import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ROOT = new URL("../../", import.meta.url);
const SCAN = ["scripts/cli", "src", "src-tauri/src"];
const EXTENSIONS = new Set([".mjs", ".ts", ".vue", ".rs"]);
const EXCLUDED = new Set([
  "scripts/cli/kernel/terms.mjs",
  "scripts/cli/kernel/terms.test.mjs",
  "src/kernel/terms-guard.test.ts",
  "src/kernel/i18n.ts",
  "src-tauri/src/board/terms.rs",
]);

function filesBelow(relative: string): string[] {
  const absolute = new URL(`${relative}/`, ROOT);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = `${relative}/${entry.name}`;
    return entry.isDirectory() ? filesBelow(child) : EXTENSIONS.has(path.extname(entry.name)) ? [child] : [];
  });
}

describe("plan reference mapper boundary", () => {
  it("keeps reference construction and parsing in one JS and one Rust module", () => {
    const violations: string[] = [];
    for (const file of SCAN.flatMap(filesBelow)) {
      if (EXCLUDED.has(file) || /\.test\./.test(file)) continue;
      const source = readFileSync(new URL(file, ROOT), "utf8");
      source.split(/\r?\n/).forEach((line, index) => {
        const buildsReference = line.includes("c#" + "${") || line.includes("p#" + "${")
          || line.includes("c#{{") || line.includes("'c#'") || line.includes('"c#"')
          || />[^<]*c#\d/i.test(line)
          || line.includes('format!("c#') || line.includes('format!("p#');
        const parsesLegacyReference = line.includes("c" + "\\s*#") || line.includes("[cp]" + "\\s*#");
        if (buildsReference || parsesLegacyReference) violations.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("keeps legacy change terminology out of Russian interface strings", () => {
    const source = readFileSync(new URL("src/kernel/i18n.ts", ROOT), "utf8");
    const russian = source.slice(source.indexOf("\n  ru: {"));
    const legacy = (russian.match(/"(?:[^"\\]|\\.)*"/g) ?? [])
      .filter((value) => /\bchange\b/i.test(value));
    expect(legacy).toEqual([]);
  });
});
