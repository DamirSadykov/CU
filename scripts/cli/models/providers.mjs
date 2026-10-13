import { CLAUDE_CODE_ENGINE } from "./claude-code.mjs";
import { CODEX_ENGINE } from "./codex.mjs";

export const OPENAI_PRICES = [
  [/gpt-5\.6-terra/i, [2, 0.2, 12]], [/gpt-5\.6-luna/i, [0.2, 0.02, 1.2]],
  [/^gpt-5\.6(?:-sol)?$/i, [4, 0.4, 20]], [/gpt-5\.3-codex/i, [1.75, 0.175, 14]],
  [/gpt-5\.2(?:-codex)?/i, [1.75, 0.175, 14]],
];

export function openAiCost(model, usage, profile = {}) {
  if (!usage) return null;
  const configured = [profile.input_cost_per_million, profile.cached_input_cost_per_million, profile.output_cost_per_million];
  const rates = configured.every((n) => typeof n === "number") ? configured : OPENAI_PRICES.find(([re]) => re.test(String(model || "")))?.[1];
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
