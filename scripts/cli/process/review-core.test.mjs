import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FILE_ANCHOR,
  STEP_ANCHOR,
  downgradeUnchanged,
  findingFormat,
  lastVerdict,
  parseFindings,
  priorFindingsBlock,
  readReviewBar,
  reviewBarText,
} from "./review-core.mjs";

let tmp;
beforeEach(() => { tmp = mkdtempSync(path.join(os.tmpdir(), "cu-review-core-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const writeBar = (text) => {
  mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  writeFileSync(path.join(tmp, ".claude", "review-bar.md"), text);
};

describe("readReviewBar", () => {
  it("returns null without the file, so kind (c) is absent", () => {
    expect(readReviewBar(tmp)).toBeNull();
    expect(reviewBarText({ subject: "diff", anchor: FILE_ANCHOR, bar: null })).not.toContain("(c)");
  });

  it("reads the usage line and the list", () => {
    writeBar("# Review bar\n\nPersonal tool, one user.\n\n- board unreadable\n* wrong usage numbers\n");
    expect(readReviewBar(tmp)).toEqual({ usage: "Personal tool, one user.", items: ["board unreadable", "wrong usage numbers"] });
  });

  it("puts kind (c) and the list into the bar when the file has items", () => {
    writeBar("Personal tool.\n- board unreadable\n");
    const text = reviewBarText({ subject: "plan", anchor: STEP_ANCHOR, bar: readReviewBar(tmp) });
    expect(text).toContain("(c) a silent breakage");
    expect(text).toContain("EXPENSIVE SILENT BREAKAGES — Personal tool.:");
    expect(text).toContain("- board unreadable");
    expect(text).toContain("names the kind, the step N and a concrete scenario");
    expect(text).toContain("fragment of the plan");
    expect(text).not.toMatch(/adversarial|incomplete/i);
  });
});

describe("parseFindings", () => {
  it("reads file:line findings and downgrades a blocking one without evidence", () => {
    const out = parseFindings([
      "- [high] src/a.mjs:4 — breaks save — click save, nothing written",
      "- [critical] src/b.mjs:9 — loses rows",
      "VERDICT: issue",
    ].join("\n"));
    expect(out.verdict).toBe("issue");
    expect(out.findings).toEqual([
      { level: "high", file: "src/a.mjs", line: 4, text: "breaks save", evidence: "click save, nothing written" },
      { level: "medium", file: "src/b.mjs", line: 9, text: "loses rows", evidence: null },
    ]);
  });

  it("reads step anchors in both languages and downgrades a blocking one without a step", () => {
    const out = parseFindings([
      "- [high] step 2 — verify does not run the new test — the gate passes on the old suite",
      "- [low] шаг 3 — wording",
      "- [high] — vague worry — scenario",
      "VERDICT: issue",
    ].join("\n"), STEP_ANCHOR);
    expect(out.findings).toEqual([
      { level: "high", step: "2", text: "verify does not run the new test", evidence: "the gate passes on the old suite" },
      { level: "low", step: "3", text: "wording", evidence: null },
      { level: "medium", step: null, text: "vague worry", evidence: "scenario" },
    ]);
  });

  it("keeps the legacy issue without structured findings as one high finding", () => {
    expect(parseFindings("plan is wrong\nVERDICT: issue", STEP_ANCHOR).findings)
      .toEqual([{ level: "high", step: null, text: "plan is wrong", evidence: null }]);
  });

  it("tells a missing verdict apart from an explicit one", () => {
    expect(lastVerdict("no line")).toBeNull();
    expect(lastVerdict("**VERDICT:** `approve`")).toBe("approve");
    expect(parseFindings("no line").verdict).toBe("issue");
  });

  it("states the line format with the anchor", () => {
    expect(findingFormat(STEP_ANCHOR)).toBe("- [critical|high|medium|low] step N — substance — evidence");
  });
});

describe("priorFindingsBlock", () => {
  it("lists prior findings first and the author's rejections", () => {
    const text = priorFindingsBlock(
      [{ level: "medium", step: "1", text: "name is vague" }],
      { anchor: STEP_ANCHOR, round: "preceding round", rejections: ["name is vague — the name is the task subject"] },
    );
    expect(text).toContain("FIRST, re-check these findings from the preceding round");
    expect(text).toContain("- [medium] step 1 — name is vague");
    expect(text).toContain("REJECTED BY THE AUTHOR");
    expect(text).toContain("- name is vague — the name is the task subject");
  });
});

describe("downgradeUnchanged", () => {
  const prior = [{ level: "high", step: "1", text: "old" }];

  it("downgrades a new blocking finding at an unchanged anchor, keeps known and changed ones", () => {
    const out = downgradeUnchanged([
      { level: "high", step: "1", text: "old", evidence: "e" },
      { level: "high", step: "2", text: "new on unchanged", evidence: "e" },
      { level: "critical", step: "3", text: "new on changed", evidence: "e" },
      { level: "medium", step: "2", text: "note", evidence: null },
    ], { prior, changed: new Set(["3"]), anchor: STEP_ANCHOR, note: "step unchanged" });
    expect(out.map((f) => f.level)).toEqual(["high", "medium", "critical", "medium"]);
    expect(out[1].evidence).toBe("e; step unchanged");
  });

  it("does nothing without a known change set", () => {
    const findings = [{ level: "high", file: "a.mjs", line: 1, text: "x", evidence: "e" }];
    expect(downgradeUnchanged(findings, { prior: [] })).toBe(findings);
  });
});
