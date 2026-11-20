import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { GUARDED_TOOLS, WRITE_TOOLS, blockedCommand, codexRules } from "./policy.mjs";

export function toolPayload(payload = {}) {
  return {
    tool: String(payload.tool_name ?? payload.toolName ?? payload.name ?? ""),
    input: payload.tool_input ?? payload.toolInput ?? payload.input ?? {},
    cwd: String(payload.cwd ?? payload.working_directory ?? payload.workingDirectory ?? process.cwd()),
  };
}

function writePaths(tool, input) {
  if (!WRITE_TOOLS.includes(tool) || !input || typeof input !== "object") return [];
  const values = [input.file_path, input.filePath, input.notebook_path, input.notebookPath, input.path];
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) values.push(edit?.file_path, edit?.filePath, edit?.path);
  }
  return values.map((v) => typeof v === "string" ? v.trim() : "").filter(Boolean);
}

export function pathInsideWorkspace(file, cwd) {
  const base = path.resolve(cwd || process.cwd());
  const target = path.resolve(base, file);
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function checkPayload(payload, { cwd } = {}) {
  const parsed = toolPayload(payload);
  if (!GUARDED_TOOLS.includes(parsed.tool)) return { allowed: true };
  if (parsed.tool === "Bash") {
    const reason = blockedCommand(parsed.input?.command ?? parsed.input?.cmd ?? parsed.input);
    return reason ? { allowed: false, reason } : { allowed: true };
  }
  const root = cwd || parsed.cwd;
  const outside = writePaths(parsed.tool, parsed.input).find((file) => !pathInsideWorkspace(file, root));
  return outside
    ? { allowed: false, reason: `write outside workspace: ${outside}` }
    : { allowed: true };
}

export function claudeGuardSettings(cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "cli.mjs")) {
  const command = `node ${JSON.stringify(cliPath)} guard`;
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: GUARDED_TOOLS.join("|"), hooks: [{ type: "command", command }] }] } });
}

async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

export async function run(args = []) {
  if (args[0] === "rules") {
    process.stdout.write(codexRules());
    return;
  }
  if (process.env.TRACKER_SESSION_KIND !== "runner") return;
  let payload;
  try { payload = JSON.parse(await readStdin()); }
  catch { return; } // a hook parsing failure must not break the host CLI
  const verdict = checkPayload(payload);
  if (process.env.CU_RUNNER_GUARD_PROOF) {
    try { writeFileSync(process.env.CU_RUNNER_GUARD_PROOF, "active"); } catch {}
  }
  if (!verdict.allowed) {
    if (args.includes("codex")) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `CU runner guard: ${verdict.reason}`,
      } }));
      return;
    }
    const error = new Error(`Command blocked by CU guard: ${verdict.reason}. Use a safe alternative or stop and report it.`);
    error.exitCode = 2;
    throw error;
  }
}
