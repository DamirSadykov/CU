// One policy, two enforcement adapters:
//   * guard.mjs checks the complete Claude Code PreToolUse payload;
//   * codexRules() emits the prefix-only subset understood by Codex execpolicy.
// Execpolicy is intentionally only a belt: workspace-write remains the file boundary.

export const WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
export const GUARDED_TOOLS = [...WRITE_TOOLS, "Bash"];

export const COMMAND_RULES = [
  { reason: "recursive rm", test: /\brm\s+(?:-\S*\s+)*-\S*[rR]|\brm\s+(?:-\S*\s+)*--recursive/, prefixes: [["rm", ["-rf", "-fr", "-r", "-R", "-Rf", "-fR", "--recursive"]]] },
  { reason: "directory deletion", test: /\brmdir\b|\brd\s+\/s|\bdel\s+\/[sq]|\berase\b/i, prefixes: [["rmdir"], ["rd", "/s"], ["del"], ["erase"]] },
  { reason: "dangerous PowerShell command", test: /Remove-Item|\bri\s+-r|Clear-Content|Format-Volume|Clear-Disk|Stop-Computer|Restart-Computer/i, prefixes: [["Remove-Item"], ["Clear-Content"], ["Format-Volume"], ["Clear-Disk"], ["Stop-Computer"], ["Restart-Computer"]] },
  { reason: "recursive deletion from code", test: /rimraf|rmSync|rmdirSync|rmtree|fs\.rm\s*\(|fs\.promises\.rm|removeSync|emptyDir/i, prefixes: [["rimraf"]] },
  { reason: "system command", test: /\bformat\s+[a-z]:|diskpart|bcdedit|\breg(?:\.exe)?\s+(?:delete|add)|cipher\s+\/w|vssadmin|wmic\s|\bshutdown\b|\btakeown\b|\bicacls\b/i, prefixes: [["format"], ["diskpart"], ["bcdedit"], ["reg", ["delete", "add"]], ["reg.exe", ["delete", "add"]], ["vssadmin"], ["shutdown"], ["takeown"], ["icacls"]] },
  { reason: "git changes the worktree or history", test: /\bgit\s+(?:-\S+\s+)*(?:reset|clean|checkout|restore|stash|push|rebase|rm|filter-branch|filter-repo|gc|prune|update-ref|branch\s+-D)\b/i, prefixes: [["git", ["reset", "clean", "checkout", "restore", "stash", "push", "rebase", "rm", "filter-branch", "filter-repo", "gc", "prune", "update-ref"]], ["git", "branch", "-D"]] },
  { reason: "docker deletion", test: /\bdocker\s+(?:rm|rmi|system\s+prune|volume\s+(?:rm|prune)|container\s+(?:rm|prune)|image\s+prune)\b/i, prefixes: [["docker", ["rm", "rmi"]], ["docker", "system", "prune"], ["docker", "volume", ["rm", "prune"]], ["docker", "container", ["rm", "prune"]], ["docker", "image", "prune"]] },
  { reason: "system configuration", test: /\bSet-ExecutionPolicy|\bnet\s+user|\bsc(?:\.exe)?\s+(?:delete|stop|config)|iisreset|appcmd/i, prefixes: [["Set-ExecutionPolicy"], ["net", "user"], ["sc", ["delete", "stop", "config"]], ["sc.exe", ["delete", "stop", "config"]], ["iisreset"], ["appcmd"]] },
  { reason: "patch deletes a file", test: /\*\*\* Delete File/, prefixes: [] },
  { reason: "restriction bypass", test: /--dangerously|Invoke-Expression|\biex\b/i, prefixes: [["Invoke-Expression"], ["iex"]] },
];

const quote = (value) => JSON.stringify(value);
const pattern = (values) => `[${values.map((v) => Array.isArray(v) ? `[${v.map(quote).join(", ")}]` : quote(v)).join(", ")}]`;

export function codexRules() {
  const lines = COMMAND_RULES.flatMap((rule) => rule.prefixes.map((prefix) =>
    `prefix_rule(pattern=${pattern(prefix)}, decision="forbidden", justification=${quote(`CU guard: ${rule.reason}`)})`,
  ));
  return `${lines.join("\n")}\n`;
}

export function blockedCommand(command) {
  const source = String(command ?? "");
  const rule = COMMAND_RULES.find(({ test }) => test.test(source));
  return rule?.reason || null;
}
