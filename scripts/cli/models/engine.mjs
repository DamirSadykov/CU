import path from "node:path";
import { spawnSync } from "node:child_process";

export const SANDBOXES = ["read-only", "workspace-write"];

export function assertSandbox(value) {
  if (!SANDBOXES.includes(value)) throw new Error(`unknown sandbox "${value}"`);
  return value;
}

export function splitBin(bin) {
  const parts = Array.isArray(bin) ? bin : [bin];
  const [file, ...prefix] = parts;
  if (!file) throw new Error("engine binary is required");
  return { file, prefix };
}

// Failure reasons are deliberately few: the fallback policy can act on
// missing/auth/limit, while timeout and model remain errors of this attempt.
export function classifyFailure({ error, stderr, stdout, code, timedOut } = {}) {
  const message = [error?.message || error, stderr, stdout].filter(Boolean).join("\n");
  if (timedOut || error?.code === "ETIMEDOUT" || /timed?\s*out|timeout/i.test(message)) return "timeout";
  if (error?.code === "ENOENT" || error?.code === "ENOTFOUND" || /not recognized|command not found|no such file/i.test(message)) return "missing";
  if (/unauthori[sz]ed|authentication|not logged in|login required|invalid api key|401\b|403\b/i.test(message)) return "auth";
  if (/rate.?limit|usage limit|quota|too many requests|429\b|credits? exhausted/i.test(message)) return "limit";
  if (/model.*(?:not found|unknown|unsupported|unavailable)|invalid.*model/i.test(message)) return "model";
  return code === 0 && !error ? null : "model";
}

function winQuote(value) {
  const v = String(value);
  if (v && !/[\s"^&|<>()%!]/.test(v)) return v;
  return `"${v.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
}

export function resolveSpawn(file, args) {
  if (process.platform !== "win32") return { file, args, opts: {} };
  if (/\.exe$/i.test(file) || file === (process.env.ComSpec || "cmd.exe")) return { file, args, opts: {} };
  if (/\.(cmd|bat)$/i.test(file) || !path.extname(file)) {
    const command = [file, ...args].map(winQuote).join(" ");
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${command}"`],
      opts: { windowsVerbatimArguments: true },
    };
  }
  return { file, args, opts: {} };
}

export function checkBinary(bin, { run = spawnSync } = {}) {
  try {
    const { file, prefix } = splitBin(bin);
    const target = resolveSpawn(file, [...prefix, "--version"]);
    const result = run(target.file, target.args, { ...target.opts, encoding: "utf8", windowsHide: true, timeout: 10_000 });
    if (result?.error?.code === "ENOENT") return { available: false, reason: "missing", error: result.error.message };
    if (result?.error) return { available: false, reason: classifyFailure({ error: result.error }), error: result.error.message };
    return { available: result?.status === 0, reason: result?.status === 0 ? null : "missing", error: String(result?.stderr || "") };
  } catch (error) {
    return { available: false, reason: classifyFailure({ error }), error: String(error?.message || error) };
  }
}

export class Engine {
  constructor(definition) {
    if (!definition?.id || typeof definition.argv !== "function" || typeof definition.parse !== "function")
      throw new Error("engine requires id, argv and parse");
    Object.assign(this, {
      observe: () => () => {},
      classifyFailure,
      guard: () => ({ active: false, reason: "guard check is not installed" }),
      available: (options = {}) => checkBinary(options.bin || definition.binary, options),
      ...definition,
    });
    Object.freeze(this);
  }
}

export function createEngine(definition) { return new Engine(definition); }
