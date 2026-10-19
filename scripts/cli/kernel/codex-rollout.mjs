import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// Codex stores sessions below date directories, while the thread id is only
// present in the rollout filename. Keep that filesystem convention in one
// place so every transcript consumer finds the same files.
export function codexRolloutFiles(threadId) {
  if (!threadId) return [];
  const sessions = path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions");
  const suffix = `-${threadId}.jsonl`;
  const files = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!visit(file)) return false;
      } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(suffix)) {
        files.push(file);
      }
    }
    return true;
  };
  return visit(sessions) ? files.sort() : null;
}
