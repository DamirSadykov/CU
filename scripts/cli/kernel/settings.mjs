// Single read layer for the tracker's settings.json, for the Node CLI side (the
// SessionStart/Stop hooks). Mirrors src/settingsStore.ts on the UI side: one place
// that knows the file path, does the read+parse, and applies each setting's
// forgiving default. The hooks used to inline the same
// `readFileSync(appData/<selected identifier>/settings.json) + JSON.parse`
// block per setting (3× in hook.mjs, 2× in stop-hook.mjs), each re-deriving the
// path and the default — this centralizes that.
//
// Contract (unchanged from the inlined versions): every getter is read-only and
// forgiving — a missing file, bad JSON, or absent/invalid key yields the default,
// never throws. `appData` is the Roaming base (process.env.APPDATA); pass it in so
// callers that already resolved it don't re-derive, or omit it to resolve here.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appDataFile, roamingBase } from "./appdata.mjs";

export { roamingBase };

const contract = JSON.parse(readFileSync(new URL("./settings-contract.json", import.meta.url), "utf8"));

export const SETTINGS_KEYS = contract.keys
  .filter(({ scope }) => scope === "shared" || scope === "hook")
  .map(({ key }) => key);

// The Roaming base that holds the app's data dir. Windows: %APPDATA%, with a
// USERPROFILE fallback for the rare case APPDATA is unset.
// Read + parse settings.json ONCE into a plain object. Never throws: any failure
// (file absent, unreadable, or not valid JSON) → {}. Callers read fields off the
// result and apply their own defaults, or use the typed getters below.
export function readSettings(appData) {
  try {
    const raw = readFileSync(
      appDataFile("settings.json", appData),
      "utf8",
    );
    const j = JSON.parse(raw);
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

// --- Typed getters (each = one setting's key + type-guard + default) ---

// `taskContextPriority`: the LOWEST priority a task must have to reach a session,
// mapped to a min rank. all|low|medium|high → 0|1|2|3. Default medium (2).
const TASK_CONTEXT_PRIORITIES = ["all", "low", "medium", "high"];
export function taskContextPriority(appData) {
  const v = readSettings(appData).taskContextPriority;
  return typeof v === "string" && TASK_CONTEXT_PRIORITIES.includes(v) ? v : "medium";
}

export function uiLocale(appData) {
  const v = readSettings(appData).locale;
  return v === "ru" || v === "en" ? v : null;
}

export function taskContextMinRank(appData) {
  const MIN = { all: 0, low: 1, medium: 2, high: 3 };
  return MIN[taskContextPriority(appData)];
}


// `hookContextEnabled`: master switch — when false the SessionStart hook injects
// nothing. Default true.
export function hookContextEnabled(appData) {
  const v = readSettings(appData).hookContextEnabled;
  return typeof v === "boolean" ? v : true;
}

// Opt in to the role/lifecycle map at SessionStart. It is separate from the
// task list so a session can receive the operating model with an empty board.
// The master `hookContextEnabled` switch in hook.mjs still overrides it.
export function workflowContextEnabled(appData) {
  return readSettings(appData).workflowContextEnabled === true;
}

export function runnerEnabled(appData) {
  return readSettings(appData).runnerEnabled !== false;
}

// `taskHandoffGuard`: which tasks owe a baton before a session ends —
// off|submitted|unfinished|both. Default both.
const TASK_GUARD_MODES = ["off", "submitted", "unfinished", "both"];
export function taskHandoffGuard(appData) {
  const v = readSettings(appData).taskHandoffGuard;
  return typeof v === "string" && TASK_GUARD_MODES.includes(v) ? v : "both";
}

// `specDeltaGuard`: does closing a task that carries a `spec` link demand an
// explicit answer per addressed section (docs/specs/README.md §8, t#341) —
// on|off. Default on: the guard is inert for a board that links no specs, so
// it costs nothing until the link is made deliberately. Only reachable at all
// while `specsEnabled` is true — the master switch below turns the whole spec
// channel off before this mode is ever consulted.
export function specDeltaGuard(appData) {
  const settings = readSettings(appData);
  const v = settings.specs?.deltaGuard ?? settings.specDeltaGuard;
  return v === "off" || v === false ? "off" : "on";
}

// `specsEnabled`: master switch for the spec registry's participation in the
// AUTOMATIC workflow — the SessionStart injection, the section printed on the
// move into in_progress, baseline recording, and the Stop guard's spec half.
// Default FALSE: a change is then just a group of tasks sharing one goal (its
// `description`, the ★ vision), and nothing asks about spec sections on its
// own. Manual `cli spec …` commands are UNAFFECTED by this switch — they stay
// fully callable either way, so a link already on a task can still be read or
// answered by hand; this only gates what happens without being asked.
export function specsEnabled(appData) {
  const settings = readSettings(appData);
  return (settings.specs?.enabled ?? settings.specsEnabled) === true;
}

// `matchPlanCli`: absolute path to a kb-style CLI that turns task/plan text into
// case-warnings. Two calls make up the contract, both optional to implement:
//   match-plan --text "<plan>" --json   — the ExitPlanMode hook (t#253)
//   match-warn --todo <id> --event <add|queue|in_progress> --tracker-cli <path>
//                                       — the task-event notify (t#250); the CLI
//                                         owns matching, dedup and comment posting
// Empty/absent (the default) disables both — the tracker itself carries no
// dependency on any knowledge base. Set by hand in settings.json.
export function matchPlanCli(appData) {
  const v = readSettings(appData).matchPlanCli;
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

// `specRoot`: where the spec registry (t#339) looks for `<domain>/spec.md`
// catalogs, relative to the project the CLI is invoked from unless it is an
// absolute path. The tracker serves several projects, and each keeps its own
// spec tree at its own place, so this is a project-side default with a
// tracker-side override — same shape as `matchPlanCli`. Default `docs/specs`
// (this project's layout, docs/specs/README.md). Set by hand in settings.json.
export function specRoot(appData) {
  const v = readSettings(appData).specRoot;
  return typeof v === "string" && v.trim() ? v.trim() : "docs/specs";
}

// `specRepos`: map of `repo` key (as named by a section's `location.repo` in
// spec.md frontmatter, docs/specs/README.md §4) to that repo's absolute local
// path, for sections whose text lives outside this repository. An unlisted key
// or a listed path that does not exist on disk both mean "not available on
// this machine" — the registry reports that as its own answer (§4/§6), never
// as a dangling reference. Empty/absent (the default) means no external repo
// is reachable from here. Set by hand in settings.json.
export function specRepos(appData) {
  const repos = readSettings(appData).specRepos;
  return repos && typeof repos === "object" ? repos : {};
}

export function specRepoPath(repoKey, appData) {
  const repos = specRepos(appData);
  const v = repos[repoKey];
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

const FLOW_LANGUAGES = new Set(["cs", "rs", "ts", "js"]);
const DEFAULT_FLOW_LANGUAGES = ["ts", "js"];
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export function flowLanguages(project, appData) {
  const all = readSettings(appData).flowLanguages;
  const configured = all && typeof all === "object" && !Array.isArray(all) ? all[String(project || "")] : null;
  if (!Array.isArray(configured)) return [...DEFAULT_FLOW_LANGUAGES];
  const selected = [...new Set(configured.filter((value) => typeof value === "string" && FLOW_LANGUAGES.has(value)))];
  return selected.length ? selected : [...DEFAULT_FLOW_LANGUAGES];
}

export function flowcheckExeCandidates(appData, repoRoot = REPO_ROOT) {
  return [
    appDataFile(path.join("tools", "flowcheck.exe"), appData),
    path.join(repoRoot, "tools", "flowcheck", "target", "release", "flowcheck.exe"),
  ];
}

export function flowcheckExe(appData, { exists = existsSync, repoRoot = REPO_ROOT } = {}) {
  const v = readSettings(appData).flowcheckExe;
  if (typeof v === "string" && v.trim()) return v.trim();
  return flowcheckExeCandidates(appData, repoRoot).find((candidate) => exists(candidate)) ?? "";
}

export function mutations(appData) {
  const v = readSettings(appData).mutations;
  const value = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : false,
    step: typeof value.step === "boolean" ? value.step : true,
    plan: typeof value.plan === "boolean" ? value.plan : true,
    stepMaxLevel: Number.isInteger(value.stepMaxLevel) && value.stepMaxLevel >= 0 && value.stepMaxLevel <= 3
      ? value.stepMaxLevel
      : 1,
  };
}

export function mutscopeDirCandidates(appData, repoRoot = REPO_ROOT) {
  return [
    path.join(repoRoot, "tools", "mutscope"),
    appDataFile(path.join("tools", "mutscope"), appData),
  ];
}

export function mutscopeDir(appData, { exists = existsSync, repoRoot = REPO_ROOT } = {}) {
  const v = readSettings(appData).mutscopeDir;
  if (typeof v === "string" && v.trim()) return v.trim();
  return mutscopeDirCandidates(appData, repoRoot).find((candidate) =>
    exists(path.join(candidate, "stryker.mjs")) && exists(path.join(candidate, "node_modules", "@stryker-mutator", "core"))) ?? "";
}

export function parkedStepExpiryHours(appData) {
  const v = readSettings(appData).parkedStepExpiryHours;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 24;
}
