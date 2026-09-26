import { Prisma } from "@prisma/client";

export type MoneyValue = Prisma.Decimal | number | string;

/**
 * Monetary columns are exact `Decimal(20, 7)` in Postgres (7 decimal places is
 * Stellar's stroop precision). Sums are computed by the database on the exact
 * values; this converts an already-summed amount to a JS number at the API and
 * email boundary, where the response shape stays a plain JSON number.
 */
export function toAmount(value: MoneyValue | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === "number" ? value : new Prisma.Decimal(value).toNumber();
}

/**
 * Prisma serializes `Decimal` as a JSON string by default. The API has always
 * returned amounts as numbers, so keep that shape for existing clients.
 */
export function installDecimalJsonSerialization(): void {
  (Prisma.Decimal.prototype as unknown as { toJSON: () => number }).toJSON = function (
    this: Prisma.Decimal
  ) {
    return this.toNumber();
  };
}
