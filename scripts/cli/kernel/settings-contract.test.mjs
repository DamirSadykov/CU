import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import contract from "./settings-contract.json" with { type: "json" };
import {
  SETTINGS_KEYS,
  flowLanguages,
  flowcheckExe,
  hookContextEnabled,
  matchPlanCli,
  parkedStepExpiryHours,
  specDeltaGuard,
  specRepoPath,
  specRepos,
  specRoot,
  specsEnabled,
  taskContextPriority,
  taskContextMinRank,
  taskHandoffGuard,
  runnerEnabled,
  uiLocale,
  workflowContextEnabled,
} from "./settings.mjs";

const CLI_CONTRACT_KEYS = contract.keys.filter(({ scope }) => scope === "shared" || scope === "hook");

describe("CLI settings contract", () => {
  it("lists exactly the shared and hook keys in the contract", () => {
    expect([...SETTINGS_KEYS].sort()).toEqual(CLI_CONTRACT_KEYS.map(({ key }) => key).sort());
  });

  it("uses each contract default when settings.json is absent", () => {
    const appData = mkdtempSync(path.join(os.tmpdir(), "settings-contract-"));
    const defaults = new Map(CLI_CONTRACT_KEYS.map(({ key, default: value }) => [key, value]));

    try {
      expect(taskContextPriority(appData)).toBe(defaults.get("taskContextPriority"));
      expect(taskContextMinRank(appData)).toBe(2);
      expect(hookContextEnabled(appData)).toBe(defaults.get("hookContextEnabled"));
      expect(workflowContextEnabled(appData)).toBe(defaults.get("workflowContextEnabled"));
      expect(runnerEnabled(appData)).toBe(defaults.get("runnerEnabled"));
      expect(taskHandoffGuard(appData)).toBe(defaults.get("taskHandoffGuard"));
      expect(specDeltaGuard(appData)).toBe(defaults.get("specs").deltaGuard);
      expect(specsEnabled(appData)).toBe(defaults.get("specs").enabled);
      expect(matchPlanCli(appData)).toBe(defaults.get("matchPlanCli"));
      expect(specRoot(appData)).toBe(defaults.get("specRoot"));
      expect(specRepos(appData)).toEqual(defaults.get("specRepos"));
      expect(specRepoPath("unlisted", appData)).toBe("");
      expect(uiLocale(appData)).toBe(defaults.get("locale"));
      expect(parkedStepExpiryHours(appData)).toBe(defaults.get("parkedStepExpiryHours"));
      expect(flowcheckExe(appData)).toBe(defaults.get("flowcheckExe"));
      expect(flowLanguages("unlisted", appData)).toEqual(["cs"]);
      expect(defaults.get("flowLanguages")).toEqual({});

      const dir = path.join(appData, "com.cu.app");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ parkedStepExpiryHours: 0 }));
      expect(parkedStepExpiryHours(appData)).toBe(0);
      writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ parkedStepExpiryHours: -1 }));
      expect(parkedStepExpiryHours(appData)).toBe(24);
      writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ flowcheckExe: " C:/tools/flowcheck.exe ", flowLanguages: { app: ["rs", "vue", "ts"], empty: [] } }));
      expect(flowcheckExe(appData)).toBe("C:/tools/flowcheck.exe");
      expect(flowLanguages("app", appData)).toEqual(["rs", "ts"]);
      expect(flowLanguages("empty", appData)).toEqual(["cs"]);
      writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ runnerEnabled: false }));
      expect(runnerEnabled(appData)).toBe(false);

      writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ specs: { enabled: true, deltaGuard: "off" } }));
      expect(specsEnabled(appData)).toBe(true);
      expect(specDeltaGuard(appData)).toBe("off");
      writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ specsEnabled: true, specDeltaGuard: "off" }));
      expect(specsEnabled(appData)).toBe(true);
      expect(specDeltaGuard(appData)).toBe("off");
    } finally {
      rmSync(appData, { recursive: true, force: true });
    }
  });
});
