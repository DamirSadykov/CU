import { readFileSync } from "node:fs";

const GUIDE_FILE = new URL("../../../docs/agent-guide.md", import.meta.url);

export function guideText() {
  return readFileSync(GUIDE_FILE, "utf8");
}

export async function run(args = [], deps = {}) {
  const out = deps.out ?? ((s) => process.stdout.write(s));
  out(guideText());
}
