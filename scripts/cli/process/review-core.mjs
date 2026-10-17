import { readFileSync } from "node:fs";
import path from "node:path";

export const REVIEW_BAR_FILE = path.join(".claude", "review-bar.md");

const normalizePath = (value) => String(value ?? "").trim().replace(/\\/g, "/");

export const FILE_ANCHOR = {
  label: "file:line",
  pattern: String.raw`(?:(\S+):(\d+)\s*)?`,
  read: ([file, line]) => ({ file: file || null, line: line ? Number(line) : null }),
  present: (f) => !!(f?.file && f?.line),
  format: (f) => `${f?.file || "(no file)"}${f?.line ? `:${f.line}` : ""}`,
  place: (f) => normalizePath(f?.file),
};

export const STEP_ANCHOR = {
  label: "step N",
  pattern: String.raw`(?:(?:step|шаг)\s+([\w.-]+)\s*)?`,
  read: ([step]) => ({ step: step || null }),
  present: (f) => !!f?.step,
  format: (f) => (f?.step ? `step ${f.step}` : "(no step)"),
  place: (f) => String(f?.step ?? "").trim(),
};

export const isBlocking = (f) => f?.level === "critical" || f?.level === "high";

export const findingKey = (f, anchor = FILE_ANCHOR) => `${anchor.place(f)}\u0000${f?.text || ""}`;

export function readReviewBar(cwd = process.cwd()) {
  let text;
  try {
    text = readFileSync(path.join(cwd, REVIEW_BAR_FILE), "utf8");
  } catch {
    return null;
  }
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim());
  const items = lines.filter((l) => /^[-*]\s+/.test(l)).map((l) => l.replace(/^[-*]\s+/, "").trim()).filter(Boolean);
  const usage = lines.find((l) => l && !/^[-*]\s+/.test(l) && !l.startsWith("#")) || "";
  if (!items.length) return null;
  return { usage, items };
}

export function reviewBarText({ subject, anchor, bar } = {}) {
  const kinds = [
    "(a) a false statement about the code, the docs or a decision, or a contradiction;",
    "(b) the main path or an ordinary action breaks, the result does not do what the work is for, or an obligation (produces, verify, needs) is unmet;",
  ];
  if (bar) kinds.push("(c) a silent breakage from the expensive list below, even from a rare state, when its fix is small.");
  const lines = [
    `BAR. A finding is critical or high only when it is of one of these kinds and names the kind, the ${anchor.label} and a concrete scenario; otherwise it is medium:`,
    ...kinds,
  ];
  if (bar) {
    lines.push(`EXPENSIVE SILENT BREAKAGES${bar.usage ? ` — ${bar.usage}` : ""}:`, ...bar.items.map((item) => `- ${item}`));
  }
  const named = bar ? "(a), (b) or (c)" : "(a) or (b)";
  const edge = bar ? "an edge case outside the expensive list" : "an edge case";
  lines.push(
    `Levels: critical = the project does not build, data is lost or corrupted, or the function is unavailable; high = any other finding of kind ${named}; medium = a partly met goal or ${edge}; low = style or a minor detail.`,
    "medium and low are deferred: they never block and go to the author as notes.",
    `Judge in proportion to what this ${subject} must get right. For each finding give one smallest fix as a fragment of the ${subject}, not a menu of options. Approve when only medium or low remain.`,
  );
  return lines.join("\n");
}

export function findingFormat(anchor) {
  return `- [critical|high|medium|low] ${anchor.label} — substance — evidence`;
}

export const verdictInstruction = (anchor) => [
  "End with exactly one decision line: `VERDICT: approve` or `VERDICT: issue`.",
  `Before it, list every finding exactly as \`${findingFormat(anchor)}\`.`,
].join("\n");

const VERDICT_RE = /^[\s*_`]*VERDICT:[\s*_`]*(approve|issue)[\s*_`]*$/gim;

export function lastVerdict(text) {
  return [...String(text || "").matchAll(VERDICT_RE)].at(-1)?.[1]?.toLowerCase() || null;
}

export const stripVerdict = (text) => String(text || "").replace(VERDICT_RE, "").trim();

export function parseFindings(text, anchor = FILE_ANCHOR) {
  const source = String(text || "");
  const verdict = lastVerdict(source) || "issue";
  const line = new RegExp(String.raw`^\s*-\s*\[(critical|high|medium|low)\]\s*${anchor.pattern}(?:—|--)\s*(.*)\s*$`, "gim");
  const findings = [];
  for (const match of source.matchAll(line)) {
    const groups = match.slice(2, -1);
    const pieces = match.at(-1).split(/\s+(?:—|--)\s+/);
    const finding = { level: match[1].toLowerCase(), ...anchor.read(groups) };
    finding.text = (pieces.shift() || "").trim();
    finding.evidence = pieces.join(" — ").trim() || null;
    if (isBlocking(finding) && (!anchor.present(finding) || !finding.evidence)) finding.level = "medium";
    findings.push(finding);
  }
  if (!findings.length && verdict === "issue") {
    findings.push({ level: "high", ...anchor.read([]), text: stripVerdict(source), evidence: null });
  }
  return { approved: verdict === "approve", verdict, findings };
}

export function priorFindingsBlock(findings, { anchor, round = "preceding attempt", rejections = [] } = {}) {
  const list = Array.isArray(findings) && findings.length
    ? findings.map((f) => `- [${f.level || "medium"}] ${anchor.format(f)} — ${f.text || "(no detail)"}`).join("\n")
    : "(the preceding review recorded no structured findings)";
  const lines = [
    `FIRST, re-check these findings from the ${round}. Do not rediscover old work as a new regression; say whether each remains.`,
    list,
    `A new critical or high finding at a ${anchor.label} that did not change since then is medium: it was there last time and did not block.`,
  ];
  if (rejections.length) {
    lines.push(
      "REJECTED BY THE AUTHOR — do not raise these again as medium or low; a critical or high one still stands if it remains:",
      ...rejections.map((r) => `- ${r}`),
    );
  }
  return lines.join("\n");
}

export function downgradeUnchanged(findings, { prior = [], changed, anchor = FILE_ANCHOR, note = "unchanged since the preceding round" } = {}) {
  if (!Array.isArray(findings) || !(changed instanceof Set)) return findings;
  const known = new Set(prior.map((f) => findingKey(f, anchor)));
  return findings.map((f) => {
    const place = anchor.place(f);
    if (isBlocking(f) && !known.has(findingKey(f, anchor)) && place && !changed.has(place))
      return { ...f, level: "medium", evidence: `${f.evidence || ""}${f.evidence ? "; " : ""}${note}` };
    return f;
  });
}
