import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const JS_SOURCE_EXTENSIONS = [
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".vue",
];
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

function slash(file) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function isJsTest(file) {
  return /(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/i.test(file);
}

function isRustIntegrationTest(file) {
  return /(?:^|\/)tests\/[^/]+\.rs$/i.test(file);
}

function hasInlineRustTests(source = "") {
  return /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\][\s\S]*?\bmod\s+tests\b/.test(source);
}

function sourceEntries(sources = {}) {
  return sources instanceof Map ? sources.entries() : Object.entries(sources);
}

function normalizeInput(files, sources) {
  const normalizedSources = new Map();
  for (const [file, source] of sourceEntries(sources)) {
    normalizedSources.set(slash(file), source);
  }
  const normalizedFiles = uniqueSorted([
    ...(files ?? []),
    ...normalizedSources.keys(),
  ].map(slash));
  return { files: normalizedFiles, sources: normalizedSources };
}

function importedSpecifiers(source = "") {
  const imports = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) imports.push(match[1]);
  }
  return imports.filter((specifier) => specifier.startsWith("."));
}

function resolveJsImport(importer, specifier, fileSet) {
  const unresolved = slash(path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier)));
  const candidates = [unresolved];
  const extension = path.posix.extname(unresolved);
  const typescript = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] }[extension];
  if (typescript) {
    const stem = unresolved.slice(0, -extension.length);
    candidates.push(...typescript.map((replacement) => `${stem}${replacement}`));
  }
  if (!extension) {
    for (const extension of JS_SOURCE_EXTENSIONS) {
      candidates.push(`${unresolved}${extension}`);
      candidates.push(`${unresolved}/index${extension}`);
    }
  }
  return candidates.find((candidate) => fileSet.has(candidate));
}

function jsLevelZero(changedFile, tests, importsByFile) {
  const directory = path.posix.dirname(changedFile);
  const stem = path.posix.basename(changedFile, path.posix.extname(changedFile));
  return tests.filter((test) => {
    const name = path.posix.basename(test);
    if (!name.startsWith(`${stem}.test.`) && !name.startsWith(`${stem}.spec.`)) return false;
    return path.posix.dirname(test) === directory || (importsByFile.get(test) ?? []).includes(changedFile);
  });
}

function reachesChangedFile(test, changedFile, importsByFile) {
  const pending = [test];
  const visited = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (current === changedFile) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(importsByFile.get(current) ?? []));
  }
  return false;
}

function jsCandidates(changedFile, files, sources) {
  const tests = files.filter(isJsTest);
  const fileSet = new Set(files);
  const importsByFile = new Map();
  for (const file of files) {
    const resolved = importedSpecifiers(sources.get(file))
      .map((specifier) => resolveJsImport(file, specifier, fileSet))
      .filter(Boolean);
    importsByFile.set(file, resolved);
  }

  const level0 = jsLevelZero(changedFile, tests, importsByFile);
  const level1 = tests.filter((test) => reachesChangedFile(test, changedFile, importsByFile));
  const layer = path.posix.dirname(changedFile);
  return [level0, level1, tests.filter((test) => within(layer, test)), tests];
}

function nearestCargoRoot(changedFile, files) {
  let directory = path.posix.dirname(changedFile);
  const fileSet = new Set(files);
  while (directory !== "." && directory !== "") {
    if (fileSet.has(`${directory}/Cargo.toml`)) return directory;
    directory = path.posix.dirname(directory);
  }
  return fileSet.has("Cargo.toml") ? "." : ".";
}

function within(root, file) {
  return root === "." || file === root || file.startsWith(`${root}/`);
}

function rustModuleNames(changedFile) {
  const stem = path.posix.basename(changedFile, ".rs");
  const parts = changedFile.split("/");
  const srcIndex = parts.lastIndexOf("src");
  const moduleParts = srcIndex >= 0 ? parts.slice(srcIndex + 1) : [stem];
  const last = moduleParts.at(-1);
  if (last === "mod.rs" || last === "lib.rs" || last === "main.rs") moduleParts.pop();
  else moduleParts[moduleParts.length - 1] = stem;
  return uniqueSorted([stem, moduleParts.join("::")].filter(Boolean));
}

function rustReferencesModule(source = "", moduleNames) {
  return moduleNames.some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:\\bmod\\s+${escaped}\\b|(?:::|\\b)${escaped}(?:::|\\b))`).test(source);
  });
}

function rustCandidates(changedFile, files, sources) {
  const cargoRoot = nearestCargoRoot(changedFile, files);
  const crateTests = files.filter((file) => within(cargoRoot, file) && isRustIntegrationTest(file));
  const allTests = files.filter(isRustIntegrationTest);
  const moduleNames = rustModuleNames(changedFile);
  const basename = path.posix.basename(changedFile, ".rs");
  const adjacent = crateTests.filter((test) => path.posix.basename(test, ".rs") === basename);
  if (hasInlineRustTests(sources.get(changedFile))) adjacent.push(changedFile);
  const referring = crateTests.filter((test) => rustReferencesModule(sources.get(test), moduleNames));

  const crateInlineTests = files.filter((file) =>
    within(cargoRoot, file) && file.endsWith(".rs") && hasInlineRustTests(sources.get(file)),
  );
  const allInlineTests = files.filter((file) => file.endsWith(".rs") && hasInlineRustTests(sources.get(file)));
  return [adjacent, referring, [...crateTests, ...crateInlineTests], [...allTests, ...allInlineTests]];
}

function disjointLevels(candidates) {
  const seen = new Set();
  return candidates.map((tests, level) => {
    const kept = uniqueSorted(tests).filter((test) => !seen.has(test));
    for (const test of kept) seen.add(test);
    return { level, tests: kept };
  });
}

export function buildTestLadder({ changedFile, files, sources = {}, language }) {
  if (!changedFile) throw new TypeError("changedFile is required");
  const normalized = normalizeInput(files, sources);
  const changed = slash(changedFile);
  const kind = language ?? (changed.endsWith(".rs") ? "rust" : "js");
  if (kind !== "js" && kind !== "rust") {
    throw new TypeError(`Unsupported language: ${kind}`);
  }
  const candidates = kind === "rust"
    ? rustCandidates(changed, normalized.files, normalized.sources)
    : jsCandidates(changed, normalized.files, normalized.sources);
  return disjointLevels(candidates);
}

async function scan(root, directory = "") {
  const absolute = path.join(root, directory);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = slash(path.join(directory, entry.name));
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) files.push(...await scan(root, relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

export async function discoverTestLadder({ root = process.cwd(), changedFile, language }) {
  const absoluteChanged = path.resolve(root, changedFile);
  const relativeChanged = slash(path.relative(root, absoluteChanged));
  const files = await scan(root);
  const readable = files.filter((file) =>
    JS_SOURCE_EXTENSIONS.includes(path.posix.extname(file)) || file.endsWith(".rs"),
  );
  const sources = new Map(await Promise.all(readable.map(async (file) => [
    file,
    await readFile(path.join(root, file), "utf8"),
  ])));
  return buildTestLadder({ changedFile: relativeChanged, files, sources, language });
}

export const testLadder = buildTestLadder;

