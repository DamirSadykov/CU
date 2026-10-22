import { readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";

const ROUTES_FILE = new URL("../../../src/contracts/app-routes.json", import.meta.url);

export function loadRoutes() {
  return JSON.parse(readFileSync(ROUTES_FILE, "utf8"));
}

function routeList(table) {
  return table.routes.map((r) => `  ${table.scheme}://${r.path}`).join("\n") + `\n  <tab>: ${table.settingsTabs.join(" | ")}`;
}

export function resolveRoute(input, table) {
  const raw = String(input ?? "").trim().replace(new RegExp(`^${table.scheme}://`, "i"), "").replace(/^\/+|\/+$/g, "");
  const parts = raw ? raw.split("/") : [];
  const [head, arg, ...extra] = parts;
  const url = (...p) => ({ url: `${table.scheme}://${p.join("/")}` });
  if (extra.length) return { error: `too many segments: ${raw}` };
  if (head === "settings") {
    if (arg === undefined) return url("settings");
    return table.settingsTabs.includes(arg) ? url("settings", arg) : { error: `unknown settings tab: ${arg}` };
  }
  if (head === "tasks") {
    if (arg === undefined) return url("tasks");
    const n = /^(?:t?#)?(\d+)$/.exec(arg);
    return n && Number(n[1]) > 0 ? url("tasks", String(Number(n[1]))) : { error: `not a task number: ${arg}` };
  }
  if (head === "analytics" && arg === undefined) return url("analytics");
  return { error: raw ? `unknown route: ${raw}` : "no route given" };
}

export function schemeRegistered(scheme = "cu") {
  if (process.platform !== "win32") return false;
  for (const key of [`HKCU\\Software\\Classes\\${scheme}`, `HKCR\\${scheme}`]) {
    try {
      execFileSync("reg", ["query", key], { stdio: "ignore", windowsHide: true });
      return true;
    } catch {}
  }
  return false;
}

function launch(url) {
  spawn("cmd.exe", ["/d", "/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

function fail(message) {
  return Object.assign(new Error(message), { exitCode: 1 });
}

const USAGE =
  "usage: cli open <route> [--print]\n" +
  "       opens a CU window on the given screen; --print only prints the cu:// link\n" +
  "       open a window only when the user asked for it\n\nroutes:\n";

export async function run(args = [], deps = {}) {
  const table = loadRoutes();
  const out = deps.out ?? ((s) => process.stdout.write(s));
  const registered = deps.registered ?? (() => schemeRegistered(table.scheme));
  const open = deps.spawn ?? launch;
  const route = args.find((a) => !a.startsWith("--"));
  if (route === undefined || args.includes("--help") || args.includes("-h")) {
    out(USAGE + routeList(table) + "\n");
    return;
  }
  const resolved = resolveRoute(route, table);
  if (resolved.error) throw fail(`${resolved.error}\nroutes:\n${routeList(table)}`);
  if (args.includes("--print")) {
    out(resolved.url + "\n");
    return;
  }
  if (!registered()) throw fail(`${table.scheme}:// scheme not registered — install CU (link: ${resolved.url})`);
  open(resolved.url);
  out(`opened ${resolved.url}\n`);
}
