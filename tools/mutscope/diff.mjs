function slash(file) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

function unquoteGitPath(value) {
  const path = value.trim().split(/\s+/)[0];
  if (path === "/dev/null") return null;
  const unquoted = path.startsWith('"') && path.endsWith('"')
    ? JSON.parse(path)
    : path;
  return slash(unquoted.replace(/^[ab]\//, ""));
}

function compactLines(lines) {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges = [];
  for (const line of sorted) {
    const last = ranges.at(-1);
    if (last && line === last.endLine + 1) last.endLine = line;
    else ranges.push({ startLine: line, endLine: line });
  }
  return ranges;
}

export function parseUnifiedDiff(input = "") {
  const files = new Map();
  let file = null;
  let newLine = 0;
  let inHunk = false;
  let deletionAnchor = null;

  const remember = (line) => {
    if (!file || line < 1) return;
    if (!files.has(file)) files.set(file, []);
    files.get(file).push(line);
  };

  for (const line of input.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      if (deletionAnchor !== null) remember(deletionAnchor);
      file = null;
      inHunk = false;
      deletionAnchor = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      file = unquoteGitPath(line.slice(4));
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      if (deletionAnchor !== null) remember(deletionAnchor);
      newLine = Number(hunk[1]);
      inHunk = true;
      deletionAnchor = null;
      continue;
    }
    if (!inHunk || !file || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+")) {
      remember(newLine);
      newLine += 1;
      deletionAnchor = null;
    } else if (line.startsWith("-")) {
      deletionAnchor ??= newLine;
    } else if (line.startsWith(" ")) {
      if (deletionAnchor !== null) remember(deletionAnchor);
      deletionAnchor = null;
      newLine += 1;
    }
  }
  if (deletionAnchor !== null) remember(deletionAnchor);

  return [...files.entries()]
    .map(([path, lines]) => ({ file: path, ranges: compactLines(lines) }))
    .filter((entry) => entry.ranges.length > 0);
}

export function mutationRanges(diff) {
  return parseUnifiedDiff(diff);
}

export function strykerMutatePatterns(diffOrEntries) {
  const entries = typeof diffOrEntries === "string"
    ? parseUnifiedDiff(diffOrEntries)
    : diffOrEntries;
  return entries.flatMap(({ file, ranges }) => ranges.map(({ startLine, endLine }) =>
    `${slash(file)}:${startLine}-${endLine}`));
}

