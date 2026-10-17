const REF = /^(?:[pc]\s*#?\s*|#\s*)?(\d+)$/i;

export function parseRef(value) {
  const raw = value && typeof value === "object" ? value.number : value;
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  const match = String(raw ?? "").trim().match(REF);
  return match ? Number(match[1]) : null;
}

function numberOf(value) {
  const number = parseRef(value);
  if (number == null) throw new TypeError(`invalid plan reference: ${String(value)}`);
  return number;
}

export const formatRef = (value) => `p#${numberOf(value)}`;
export const storageRef = (value) => `c#${numberOf(value)}`;

const PLAN_REF = /^[pc]\s*#?\s*(\d+)$/i;

export function parsePlanRef(value) {
  const match = String(value ?? "").trim().match(PLAN_REF);
  return match ? Number(match[1]) : null;
}
