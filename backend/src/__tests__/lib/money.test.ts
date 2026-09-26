import { Prisma } from "@prisma/client";
import { installDecimalJsonSerialization, toAmount } from "../../lib/money";

describe("toAmount", () => {
  it("passes plain numbers through and treats null/undefined as 0", () => {
    expect(toAmount(12.5)).toBe(12.5);
    expect(toAmount(null)).toBe(0);
    expect(toAmount(undefined)).toBe(0);
  });

  it("converts a Decimal exactly where float addition drifts", () => {
    // Regression case for the Float columns: binary floats give 0.30000000000000004.
    expect(0.1 + 0.2).not.toBe(0.3);
    const exact = new Prisma.Decimal("0.1").plus("0.2");
    expect(toAmount(exact)).toBe(0.3);
  });

  it("sums many small amounts without accumulating error", () => {
    const floatSum = Array.from({ length: 10 }, () => 0.1).reduce((a, b) => a + b, 0);
    const decimalSum = Array.from({ length: 10 }, () => new Prisma.Decimal("0.1")).reduce(
      (a, b) => a.plus(b),
      new Prisma.Decimal(0)
    );
    expect(floatSum).not.toBe(1);
    expect(toAmount(decimalSum)).toBe(1);
  });

  it("keeps 7 decimal places (stroop precision)", () => {
    expect(toAmount("1234.5678901")).toBe(1234.5678901);
  });
});

describe("installDecimalJsonSerialization", () => {
  it("serializes Decimal values as JSON numbers, matching the previous API shape", () => {
    installDecimalJsonSerialization();
    expect(JSON.stringify({ amount: new Prisma.Decimal("25.5") })).toBe('{"amount":25.5}');
  });
});
