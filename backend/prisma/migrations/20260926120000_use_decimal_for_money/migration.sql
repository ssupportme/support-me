-- Monetary columns move from double precision (Float) to exact NUMERIC(20, 7).
-- Seven decimal places is Stellar's stroop precision, so no real amount loses
-- information; up to 13 integer digits are allowed.
--
-- Backward compatible with existing rows: each value is cast through numeric
-- (which uses the 15 significant digits a double can actually hold) and rounded
-- to 7 places, so binary noise such as 0.30000000000000004 becomes exactly 0.3
-- and NULLs stay NULL. The API keeps returning these as JSON numbers.
--
-- Rollback: ALTER COLUMN ... TYPE DOUBLE PRECISION USING "col"::double precision
-- for each column below.

-- AlterTable
ALTER TABLE "Donation" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(20,7) USING ROUND("amount"::numeric, 7);

-- AlterTable
ALTER TABLE "Withdrawal" ALTER COLUMN "amountIn" SET DATA TYPE DECIMAL(20,7) USING ROUND("amountIn"::numeric, 7),
ALTER COLUMN "amountOut" SET DATA TYPE DECIMAL(20,7) USING ROUND("amountOut"::numeric, 7),
ALTER COLUMN "fee" SET DATA TYPE DECIMAL(20,7) USING ROUND("fee"::numeric, 7);

-- AlterTable
ALTER TABLE "Subscription" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(20,7) USING ROUND("amount"::numeric, 7);
