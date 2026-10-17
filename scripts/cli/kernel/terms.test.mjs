import { describe, expect, it } from "vitest";
import { formatRef, parsePlanRef, parseRef, storageRef } from "./terms.mjs";

describe("plan reference terms", () => {
  it.each([["p#12", 12], ["c#12", 12], ["#12", 12], ["12", 12], [12, 12], [{ number: 12 }, 12]])(
    "parses %j", (input, number) => expect(parseRef(input)).toBe(number),
  );

  it("keeps display and storage references deliberately different", () => {
    expect(formatRef("c#7")).toBe("p#7");
    expect(storageRef("p#7")).toBe("c#7");
  });

  it("rejects unrelated and malformed references", () => {
    expect(parseRef("t#7")).toBeNull();
    expect(parseRef("plan 7")).toBeNull();
    expect(() => formatRef("nope")).toThrow(/invalid plan reference/);
  });
});

describe("plan-only references", () => {
  it.each([["p#115", 115], ["c#115", 115], ["P 115", 115], ["p115", 115]])("reads %j as a plan", (input, number) => {
    expect(parsePlanRef(input)).toBe(number);
  });

  it.each(["#115", "115", "t#115", "plan"])("leaves %j to the task search", (input) => {
    expect(parsePlanRef(input)).toBeNull();
  });
});
