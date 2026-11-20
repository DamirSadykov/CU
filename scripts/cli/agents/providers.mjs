// Compatibility facade for existing callers. Provider-independent lifecycle
// code can keep this API while CLI details live in the models layer.
export { READ_ONLY_TOOLS, parseClaudeResult } from "../models/claude-code.mjs";
export { parseCodexResult, observeCodexThread } from "../models/codex.mjs";
export { SANDBOXES, resolveSpawn } from "../models/engine.mjs";
export { Candidate, createCandidate, runCandidate } from "../models/candidate.mjs";
export { openAiCost } from "../models/providers.mjs";

import { claudeCodeArgv, normalizeClaudeResult } from "../models/claude-code.mjs";
import { codexArgv, parseCodexResult } from "../models/codex.mjs";

export function providerArgv(profile, options = {}) {
  return String(profile?.provider || "").toLowerCase() === "openai"
    ? codexArgv(profile, options)
    : claudeCodeArgv(profile, options);
}

export function parseProviderResult(provider, stdout) {
  return String(provider || "").toLowerCase() === "openai"
    ? parseCodexResult(stdout)
    : normalizeClaudeResult(stdout);
}
