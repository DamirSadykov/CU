export function normalizeProblem(problem) {
  return String(problem ?? "").trim().replace(/\s+/g, " ");
}

export function flowProblems(parsed) {
  return (Array.isArray(parsed?.results) ? parsed.results : [])
    .filter((result) => result?.status === "fail")
    .flatMap((result) => (Array.isArray(result.problems) ? result.problems : [])
      .map((p) => normalizeProblem(p))
      .filter(Boolean)
      .map((problem) => `${String(result.method ?? "unknown method").trim() || "unknown method"}: ${problem}`));
}

export function collectItems(items, config) {
  const out = [];
  for (const item of items) {
    out.push(item);
  }
  send(config);
  return out;
}

function send(payload) {
  return payload;
}
