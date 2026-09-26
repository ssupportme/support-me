-- AlterTable
-- Optional quick-select donation amounts a creator can configure from
-- Settings (#120), e.g. [1, 5, 10, 25]. Defaults to an empty array rather
-- than NULL so existing rows don't need a NULL-vs-"never set" branch --
-- an empty array already means "use the frontend's hardcoded defaults".
ALTER TABLE "Creator" ADD COLUMN "presetAmounts" DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[]::DOUBLE PRECISION[];
