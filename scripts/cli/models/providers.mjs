import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLAUDE_CODE_ENGINE } from "./claude-code.mjs";
import { CODEX_ENGINE } from "./codex.mjs";

// Shared with src-tauri/src/analytics/codex.rs. Keeping the model-family
// matching and rates in data prevents the CLI and analytics window from
// silently assigning different prices to the same rollout model.
export const OPENAI_PRICES = Object.freeze(JSON.parse(readFileSync(
  fileURLToPath(new URL("./openai-prices.json", import.meta.url)),
  "utf8",
)));

function openAiRates(model) {
  const candidate = String(model || "").toLowerCase();
  const rule = OPENAI_PRICES.find(({ match, models }) =>
    models.some((name) => match === "exact" ? candidate === name : candidate.includes(name)),
  );
  return rule ? [rule.input, rule.cached_input, rule.output] : null;
}

export function openAiCost(model, usage, profile = {}) {
  if (!usage) return null;
  const configured = [profile.input_cost_per_million, profile.cached_input_cost_per_million, profile.output_cost_per_million];
  const rates = configured.every((n) => typeof n === "number") ? configured : openAiRates(model);
  if (!rates) return null;
  const input = Number(usage.input_tokens ?? usage.input ?? 0), cached = Number(usage.cached_input_tokens ?? usage.cached_input ?? 0);
  const cacheWrite = Number(usage.cache_write_input_tokens ?? usage.cache_write_input ?? 0), output = Number(usage.output_tokens ?? usage.output ?? 0);
  return (Math.max(0, input - cached - cacheWrite) * rates[0] + cached * rates[1] + cacheWrite * rates[0] * 1.25 + output * rates[2]) / 1_000_000;
}

export class Provider {
  constructor(definition) { Object.assign(this, definition); Object.freeze(this.models); Object.freeze(this); }
}

export const PROVIDERS = Object.freeze({
  anthropic: new Provider({ id: "anthropic", label: "Anthropic", engine: CLAUDE_CODE_ENGINE, models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"], cost: (_m, _u, parsed) => parsed?.costUsd ?? null }),
  openai: new Provider({ id: "openai", label: "OpenAI", engine: CODEX_ENGINE, models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"], cost: openAiCost }),
});

export function getProvider(value) {
  const id = typeof value === "string" ? value.toLowerCase() : String(value?.provider || value?.id || "").toLowerCase();
  if (!PROVIDERS[id]) throw new Error(`unknown provider "${id}"`);
  return PROVIDERS[id];
}

export function providerCost(provider, model, usage, profile = {}, parsed = null) {
  const p = getProvider(provider);
  return p.id === "anthropic" ? p.cost(model, usage, parsed) : p.cost(model, usage, profile);
}
