-- Distributed-executor claim (#394): a tick() claims each due subscription
-- before charging it so concurrent backend instances never submit the same
-- charge. An abandoned claim (crashed instance) is reclaimed once it is older
-- than SUBSCRIPTION_EXECUTOR_CLAIM_TTL_MS.
ALTER TABLE "Subscription" ADD COLUMN "claimedAt" TIMESTAMP(3);
ALTER TABLE "Subscription" ADD COLUMN "claimedBy" TEXT;
