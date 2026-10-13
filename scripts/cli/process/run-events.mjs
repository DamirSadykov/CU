import { appendFileSync, mkdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import { withDataDir } from "../kernel/board-lock.mjs";

const changeId = (value) => {
  const text = String(value?.number ?? value ?? "").trim();
  return text ? (text.startsWith("c#") ? text : `c#${text.replace(/^#/, "")}`) : "";
};

const taskId = (value) => {
  const text = String(value?.number ?? value ?? "").trim();
  return text ? (text.startsWith("t#") ? text : `t#${text.replace(/^#/, "")}`) : "";
};

export function runEventsPath(runLogFile) {
  return path.join(path.dirname(runLogFile), "run-events.jsonl");
}

export function appendRunEvent(event, file) {
  if (!event) return false;
  if (file) return appendRunEventFile(event, file);
  try {
    return withDataDir((dir) => appendRunEventFile(event, path.join(dir, "run-events.jsonl")));
  } catch {
    return false;
  }
}

function appendRunEventFile(event, file) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
    return true;
  } catch {
    return false;
  }
}

export const VERIFY_LOG_LIMIT = 1024 * 1024;

export function verifyLogPath(dataDir, run, task, attempt) {
  return path.join(dataDir, "run-logs", String(run), `t${String(task).replace(/^t?#/, "")}-a${attempt}-verify.log`);
}

export function createVerifyLog(limit = VERIFY_LOG_LIMIT) {
  let chunks = [];
  let kept = 0;
  let dropped = 0;
  return {
    get size() { return kept + dropped; },
    push(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""), "utf8");
      if (!buf.length) return;
      chunks.push(buf);
      kept += buf.length;
      while (kept > limit && chunks.length) {
        const extra = kept - limit;
        if (chunks[0].length <= extra) {
          kept -= chunks[0].length;
          dropped += chunks[0].length;
          chunks.shift();
        } else {
          chunks[0] = chunks[0].subarray(extra);
          kept -= extra;
          dropped += extra;
        }
      }
    },
    bytes() {
      const body = Buffer.concat(chunks);
      if (!dropped) return body;
      const header = (count) => Buffer.from(`[verify log truncated: ${count} bytes dropped from the start]
`, "utf8");
      let cut = Math.min(body.length, Math.max(0, body.length + header(dropped + body.length).length - limit));
      while (cut < body.length && (body[cut] & 0xc0) === 0x80) cut += 1;
      return Buffer.concat([header(dropped + cut), body.subarray(cut)]);
    },
  };
}

export function writeVerifyLog(file, log) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, log.bytes());
    return true;
  } catch {
    return false;
  }
}

export function formatRunEvent(event) {
  const prefix = [changeId(event?.change), taskId(event?.task)].filter(Boolean).join(" ");
  const attempt = event?.attempt == null ? "" : ` attempt ${event.attempt}/${event.limit ?? "-"}`;
  const kind = String(event?.kind || "event");
  if (kind === "review") {
    const counts = event.counts || {};
    return `${prefix}${attempt}: review high ${counts.high || 0}, medium ${counts.medium || 0}`.trim();
  }
  if (kind === "verify") return `${prefix}${attempt}: verify ${event.ok ? "ok" : "issue"}`.trim();
  if (kind === "rollback") return `${prefix}${attempt}: rollback to ${event.to ?? "previous attempt"}`.trim();
  if (kind === "park") return `${prefix}: park ${event.park_kind || event.stop_kind || "unknown"}${event.reason ? ` — ${event.reason}` : ""}`.trim();
  if (kind === "step_start") return `${prefix}${attempt}: step start${event.route ? ` (${event.route})` : ""}`.trim();
  if (kind === "worker_done") {
    const fallback = Array.isArray(event.fallback) && event.fallback.length ? `, fallback ${event.fallback.map((item) => `${item.provider}/${item.model}:${item.reason}`).join(" -> ")}` : "";
    const inherit = event.inherit_dropped ? ", inherit dropped" : "";
    return `${prefix}${attempt}: worker done${typeof event.cost === "number" ? ` $${Math.round(event.cost * 10000) / 10000}` : ""} [guard ${event.guard || "absent"}${fallback}${inherit}]`.trim();
  }
  if (kind === "run_start" || kind === "run_end") return `${changeId(event?.change)}: ${kind.replace("_", " ")}`.trim();
  if (kind === "worker_session") return `${prefix}${attempt}: worker session ${event.engine || "?"} ${event.session || ""}`.trim();
  if (kind === "attempt_snapshot") return `${prefix}${attempt}: snapshot ${String(event.snapshot || "").slice(0, 12)}`.trim();
  if (kind === "attempt_end") return `${prefix}${attempt}: attempt end ${event.outcome || "?"} (${event.reason || "?"})${event.detail ? ` — ${event.detail}` : ""}`.trim();
  if (kind === "escalate") return `${prefix}${attempt}: escalate${event.route ? ` (${event.route})` : ""}`.trim();
  return `${prefix}${attempt}: ${kind}`.trim();
}

function lastRunStart(file, expected) {
  let raw;
  try { raw = readFileSync(file); } catch { return 0; }
  let offset = 0, found = 0;
  for (const line of raw.toString("utf8").split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.kind === "run_start" && changeId(event.change) === expected) found = offset;
    } catch {}
    offset += Buffer.byteLength(line) + 1;
  }
  return found;
}

export function watchRunEvents({ change, file, from, onLine = (line) => process.stdout.write(line + "\n"), signal } = {}) {
  const expected = changeId(change);
  mkdirSync(path.dirname(file), { recursive: true });
  let offset = from === "start" ? lastRunStart(file, expected) : (() => { try { return statSync(file).size; } catch { return 0; } })();
  return new Promise((resolve) => {
    let closed = false;
    let watcher;
    let poll;
    const close = () => {
      if (closed) return;
      closed = true;
      watcher?.close();
      clearInterval(poll);
      signal?.removeEventListener?.("abort", close);
      resolve();
    };
    const read = () => {
      let raw;
      try { raw = readFileSync(file, "utf8"); } catch { return; }
      if (Buffer.byteLength(raw) < offset) offset = 0;
      const next = Buffer.from(raw).subarray(offset).toString("utf8");
      offset = Buffer.byteLength(raw);
      for (const line of next.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (changeId(event.change) !== expected) continue;
        onLine(formatRunEvent(event), event);
        if (event.kind === "park" || event.kind === "run_end") return close();
      }
    };
    signal?.addEventListener?.("abort", close, { once: true });
    try { watcher = watch(path.dirname(file), { persistent: true }, (_, name) => { if (!name || String(name) === path.basename(file)) read(); }); } catch {}
    poll = setInterval(read, 1000);
    read();
  });
}
