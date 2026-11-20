import { assertSandbox, createEngine, splitBin } from "./engine.mjs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { homedir, tmpdir } from "node:os";

export function codexArgv(profile = {}, { bin = "codex", inherit = "", sandbox = "read-only" } = {}) {
  assertSandbox(sandbox);
  const { file, prefix } = splitBin(bin);
  const args = [...prefix, "exec", "--json", "--sandbox", sandbox];
  const model = String(profile.model || "").trim();
  if (model) args.push("--model", model);
  if (profile.reasoning_effort) args.push("--config", `model_reasoning_effort=\"${profile.reasoning_effort}\"`);
  if (inherit) args.push("fork", inherit);
  args.push("-");
  return { file, args };
}

export function parseCodexResult(stdout) {
  let sessionId = "", answer = "", error = "", usage = null;
  for (const line of String(stdout || "").split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (["thread.started", "session.started"].includes(rec.type)) sessionId = String(rec.thread_id || rec.session_id || rec.id || "");
    const item = rec.item || rec.payload?.item;
    if (rec.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") answer = item.text;
    if (["turn.completed", "response.completed"].includes(rec.type) && rec.usage) usage = rec.usage;
    if (rec.type === "error" || rec.type === "turn.failed") error = String(rec.message || rec.error?.message || rec.error || rec.type);
  }
  if (!sessionId && !answer && !usage && !error) return null;
  const raw = { sessionId, answer, usage, error };
  return { ...raw, costUsd: null, raw };
}

export function observeCodexThread(onThread) {
  let pending = "";
  return (chunk) => {
    pending += String(chunk || "");
    const lines = pending.split("\n");
    pending = lines.pop() || "";
    for (const line of lines) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (["thread.started", "session.started"].includes(rec.type)) {
        const id = String(rec.thread_id || rec.session_id || rec.id || "");
        if (id) onThread(id);
      }
    }
  };
}

export const CODEX_ENGINE = createEngine({
  id: "codex",
  binary: "codex",
  argv: codexArgv,
  parse: parseCodexResult,
  observe: observeCodexThread,
  guardSession: () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cu-codex-guard-"));
    const proofFile = path.join(dir, "observed");
    return {
      env: { CU_RUNNER_GUARD_PROOF: proofFile },
      check: () => {
        let active = false;
        try { active = readFileSync(proofFile, "utf8") === "active"; } catch {}
        return { active };
      },
      close: () => rmSync(dir, { recursive: true, force: true }),
    };
  },
  guard: ({ hooksFile = path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "hooks.json") } = {}) => {
    let groups = [];
    try { groups = JSON.parse(readFileSync(hooksFile, "utf8"))?.hooks?.PreToolUse || []; } catch {}
    const configured = Array.isArray(groups) && groups.some((group) => group?.matcher === "Bash"
      && Array.isArray(group.hooks) && group.hooks.some((hook) => hook?.type === "command" && /cli\.mjs["']?\s+guard --host codex\s*$/.test(hook.command)));
    return { active: false, configured, reason: configured
      ? "CU runner hook is configured; trust it in Codex /hooks. Activation is observed during each agent run"
      : "CU runner hook is absent; reinstall the Codex integration", path: hooksFile };
  },
});

export default CODEX_ENGINE;
