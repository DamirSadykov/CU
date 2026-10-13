import { readFileSync } from "node:fs";
import { dutyModeReader } from "./duty-mode.mjs";

const manifest = JSON.parse(readFileSync(new URL("./agent-providers.json", import.meta.url), "utf8"));
const mode = dutyModeReader(manifest);
const DUTIES = Object.keys(manifest.duties);
const RISKS = new Set(["high"]);
const CANDIDATE_KEYS = [
  "provider", "model", "reasoning_effort", "input_cost_per_million",
  "cached_input_cost_per_million", "output_cost_per_million",
];

function alias(provider, model) {
  return manifest.providers?.[provider]?.aliases?.[model] || model;
}

export function cleanCandidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const provider = String(value.provider || "").trim().toLowerCase();
  const model = alias(provider, String(value.model || "").trim());
  if (!manifest.providers?.[provider]?.models?.includes(model)) return null;
  const out = { ...value, provider, model };
  const effort = String(value.reasoning_effort || "").trim();
  if (effort) out.reasoning_effort = effort;
  else delete out.reasoning_effort;
  for (const key of CANDIDATE_KEYS.filter((key) => key.endsWith("_cost_per_million"))) {
    if (value[key] === undefined) continue;
    const number = Number(value[key]);
    if (Number.isFinite(number) && number >= 0) out[key] = number;
    else delete out[key];
  }
  return out;
}

function sameCandidate(a, b) {
  return a?.provider === b?.provider && a?.model === b?.model;
}

function starterCandidates(duty) {
  return (manifest.duties[duty]?.candidates || []).map(cleanCandidate).filter(Boolean);
}

function migrateDuty(duty, value, raw) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const out = { ...source };
  for (const key of CANDIDATE_KEYS) delete out[key];
  out.mode = mode.resolveMode(duty, source, raw);

  let candidates;
  if (Array.isArray(source.candidates)) candidates = source.candidates.map(cleanCandidate).filter(Boolean);
  else {
    const primary = cleanCandidate(Object.fromEntries(CANDIDATE_KEYS
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]])));
    candidates = primary ? [primary] : [];
    const reserve = starterCandidates(duty).find((candidate) => !candidates.some((item) => sameCandidate(item, candidate)));
    if (reserve) candidates.push(reserve);
  }
  if (!candidates.length) candidates = starterCandidates(duty);
  out.candidates = candidates;
  return out;
}

function legacyDutySource(raw) {
  if (raw?.duties && typeof raw.duties === "object" && !Array.isArray(raw.duties)) return raw.duties;
  return {
    architect: raw?.profiles?.architect,
    worker: raw?.profiles?.worker,
    review: raw?.profiles?.review || raw?.profiles?.reviewer,
  };
}

function migrateRoutes(routes) {
  if (!routes || typeof routes !== "object" || Array.isArray(routes)) return routes || {};
  const out = structuredClone(routes);
  for (const [risk, entries] of Object.entries(out)) {
    if (!RISKS.has(risk)) continue;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const [duty, route] of Object.entries(entries)) {
      if (!DUTIES.includes(duty)) continue;
      const list = Array.isArray(route) ? route : [route];
      const candidates = list.map(cleanCandidate).filter(Boolean);
      if (candidates.length) entries[duty] = candidates;
      else delete entries[duty];
    }
  }
  return out;
}

export function isValidV5(raw) {
  if (!raw || raw.version !== 5 || !raw.duties || typeof raw.duties !== "object" || Array.isArray(raw.duties)) return false;
  const dutiesValid = DUTIES.every((duty) => {
    const entry = raw.duties[duty];
    return entry && typeof entry === "object" && Array.isArray(entry.candidates)
      && entry.candidates.length > 0 && entry.candidates.every((candidate) => !!cleanCandidate(candidate))
      && !!mode.cleanMode(duty, entry.mode);
  });
  if (!dutiesValid) return false;
  const high = raw.routes?.high;
  if (high !== undefined && (!high || typeof high !== "object" || Array.isArray(high))) return false;
  return !high || DUTIES.every((duty) => high[duty] === undefined || (
    Array.isArray(high[duty]) && high[duty].length > 0 && high[duty].every((candidate) => !!cleanCandidate(candidate))
  ));
}

// Pure and idempotent. Known legacy switches disappear; every other key is
// copied, including application/user extensions we do not understand.
export function migrateAgentConfig(input) {
  const raw = input && typeof input === "object" && !Array.isArray(input) ? structuredClone(input) : {};
  if (isValidV5(raw)) return raw;
  const source = legacyDutySource(raw);
  const duties = source && typeof source === "object" && !Array.isArray(source) ? structuredClone(source) : {};
  for (const duty of DUTIES) duties[duty] = migrateDuty(duty, source?.[duty], raw);
  const { hooks: _hooks, criticMode: _criticMode, profiles, ...rest } = raw;
  const out = { ...rest, version: 5, duties, routes: migrateRoutes(raw.routes) };
  if (profiles && typeof profiles === "object" && !Array.isArray(profiles)) {
    // Known profiles became duties; custom ones are user settings and stay.
    const { architect: _a, worker: _w, review: _r, reviewer: _rv, ...extra } = profiles;
    if (Object.keys(extra).length) out.profiles = extra;
  }
  return out;
}

export const migrateV4ToV5 = migrateAgentConfig;
