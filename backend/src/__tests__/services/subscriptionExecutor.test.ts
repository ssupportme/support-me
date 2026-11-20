jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    subscription: {
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    donation: {
      upsert: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

jest.mock("../../services/subscriptionNotifications", () => ({
  notifySubscriptionPaymentFailed: jest.fn(),
  notifySubscriptionRenewed: jest.fn(),
}));

jest.mock("../../services/goalService", () => ({
  applyDonationToGoals: jest.fn(),
}));

jest.mock("../../services/donationNotifications", () => ({
  notifyGoalsReached: jest.fn(),
}));

import { Subscription } from "@prisma/client";
import prisma from "../../prisma";
import { SubscriptionExecutor } from "../../services/subscriptionExecutor";
import {
  notifySubscriptionPaymentFailed,
  notifySubscriptionRenewed,
} from "../../services/subscriptionNotifications";
import { applyDonationToGoals } from "../../services/goalService";
import { notifyGoalsReached } from "../../services/donationNotifications";
import {
  decodeChargeErrorReason,
  parseLastErrorReason,
  SubscriptionChargeErrorReason,
} from "../../services/subscriptionExecutor";

// `charge` and `submitCharge` are private; this type exposes exactly those
// two members for the tests below to call directly, instead of casting the
// whole executor instance to `any` and losing type-checking on everything
// else these tests touch on it.
type ExecutorTestAccess = {
  submitCharge: (subscription: Subscription) => Promise<string>;
  charge: (subscription: Subscription) => Promise<void>;
};

const mockedPrisma = prisma as unknown as {
  subscription: { findMany: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
  donation: { upsert: jest.Mock };
  $transaction: jest.Mock;
};
const mockedRenewed = notifySubscriptionRenewed as jest.Mock;
const mockedPaymentFailed = notifySubscriptionPaymentFailed as jest.Mock;
const mockedApplyToGoals = applyDonationToGoals as jest.Mock;
const mockedNotifyGoalsReached = notifyGoalsReached as jest.Mock;

const subscription = {
  id: 4,
  creatorId: 7,
  supporterAddress: "G supporter",
  token: "XLM",
  amount: 2.5,
  intervalSecs: 60,
  onChainId: 11,
  active: true,
  nextChargeAt: new Date(0),
  createdAt: new Date(0),
  updatedAt: new Date(0),
  lastChargeTxHash: null,
  lastChargedAt: null,
  lastError: null,
  failureNotifiedAt: null,
  subscribeTxHash: null,
} as never;

describe("SubscriptionExecutor donation indexing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedPrisma.donation.upsert.mockResolvedValue({ id: 1 });
    mockedPrisma.subscription.update.mockResolvedValue(subscription);
    mockedPrisma.$transaction.mockImplementation(
      async (callback: ((client: typeof mockedPrisma) => Promise<unknown>) | Promise<unknown>[]) => {
        if (typeof callback === "function") {
          return callback(mockedPrisma);
        }
        return Promise.all(callback);
      }
    );
    mockedRenewed.mockResolvedValue(undefined);
    mockedApplyToGoals.mockResolvedValue([]);
    mockedNotifyGoalsReached.mockResolvedValue(undefined);
  });

  it("upserts a confirmed recurring charge by its on-chain identity", async () => {
    const executor = new SubscriptionExecutor() as unknown as ExecutorTestAccess;
    executor.submitCharge = jest.fn().mockResolvedValue("charge-tx");

    await executor.charge(subscription);

    expect(mockedPrisma.donation.upsert).toHaveBeenCalledWith({
      where: {
        transactionHash_operationIndex_eventIndex: {
          transactionHash: "charge-tx",
          operationIndex: 0,
          eventIndex: 0,
        },
      },
      update: {},
      create: expect.objectContaining({
        transactionHash: "charge-tx",
        onChainEventId: "charge-tx:0:0",
        operationIndex: 0,
        eventIndex: 0,
      }),
    });
    expect(mockedPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("notifies the creator about goals the recurring charge carried to their target", async () => {
    const reachedGoal = { id: 3, creatorId: 7, title: "New mic", targetAmount: 100, currency: "XLM" };
    mockedApplyToGoals.mockResolvedValue([reachedGoal]);
    const executor = new SubscriptionExecutor() as unknown as ExecutorTestAccess;
    executor.submitCharge = jest.fn().mockResolvedValue("charge-tx");

    await executor.charge(subscription);

    expect(mockedApplyToGoals).toHaveBeenCalledWith(mockedPrisma, 7, "XLM", 2.5);
    expect(mockedNotifyGoalsReached).toHaveBeenCalledWith([reachedGoal]);
  });
});

describe("SubscriptionExecutor executor-side failures (#279)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedPrisma.subscription.update.mockResolvedValue(subscription);
    mockedPaymentFailed.mockResolvedValue(true);
  });

  it("does not penalize the subscriber when the executor account is unfunded", async () => {
    const executor = new SubscriptionExecutor() as unknown as ExecutorTestAccess;
    executor.submitCharge = jest
      .fn()
      .mockRejectedValue(new Error("Account not found: G-EXECUTOR"));

    await executor.charge(subscription);

    expect(mockedPaymentFailed).not.toHaveBeenCalled();
    expect(mockedPrisma.subscription.update).toHaveBeenCalledWith({
      where: { id: 4 },
      data: { lastError: "Account not found: G-EXECUTOR" },
    });
    expect(mockedPrisma.subscription.update.mock.calls[0][0].data.failureCount).toBeUndefined();
  });

  it("does not penalize the subscriber when the executor cannot cover the fee", async () => {
    const executor = new SubscriptionExecutor() as unknown as ExecutorTestAccess;
    executor.submitCharge = jest.fn().mockRejectedValue(new Error("insufficient fee"));

    await executor.charge(subscription);

    expect(mockedPaymentFailed).not.toHaveBeenCalled();
    expect(mockedPrisma.subscription.update.mock.calls[0][0].data.failureCount).toBeUndefined();
  });

  it("still records a genuine on-chain failure against the subscriber and emails once", async () => {
    const executor = new SubscriptionExecutor() as unknown as ExecutorTestAccess;
    executor.submitCharge = jest
      .fn()
      .mockRejectedValue(new Error("Transaction abc failed on-chain"));

    await executor.charge(subscription);

    expect(mockedPaymentFailed).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.subscription.update.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ failureCount: 1 })
    );
  });

  it("stores a typed InsufficientAllowance reason when the simulation error names it (#283)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const executor = new SubscriptionExecutor() as any;
    executor.submitCharge = jest
      .fn()
      .mockRejectedValue(new Error("HostError: Error(Contract, #1)"));

    await executor.charge(subscription);

    expect(mockedPrisma.subscription.update.mock.calls[0][0].data.lastError).toBe(
      "InsufficientAllowance: HostError: Error(Contract, #1)"
    );
  });

  it("stores a typed InsufficientBalance reason when the simulation error names it (#283)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const executor = new SubscriptionExecutor() as any;
    executor.submitCharge = jest
      .fn()
      .mockRejectedValue(new Error("HostError: Error(Contract, #2)"));

    await executor.charge(subscription);

    expect(mockedPrisma.subscription.update.mock.calls[0][0].data.lastError).toBe(
      "InsufficientBalance: HostError: Error(Contract, #2)"
    );
  });
});

describe("decodeChargeErrorReason (#283)", () => {
  it("maps contract error code #1 to InsufficientAllowance", () => {
    expect(decodeChargeErrorReason("Error(Contract, #1)")).toBe(
      SubscriptionChargeErrorReason.InsufficientAllowance
    );
  });

  it("maps contract error code #2 to InsufficientBalance", () => {
    expect(decodeChargeErrorReason("Error(Contract, #2)")).toBe(
      SubscriptionChargeErrorReason.InsufficientBalance
    );
  });

  it("returns undefined for an unrelated error message", () => {
    expect(decodeChargeErrorReason("Account not found: G...")).toBeUndefined();
  });

  it("returns undefined for an unrecognized contract error code", () => {
    expect(decodeChargeErrorReason("Error(Contract, #99)")).toBeUndefined();
  });

  it("maps contract error code #3 to TokenNotAllowed (#465)", () => {
    expect(decodeChargeErrorReason("Error(Contract, #3)")).toBe(
      SubscriptionChargeErrorReason.TokenNotAllowed
    );
  });

  it("maps contract error code #4 to AmountOutOfBounds (#465)", () => {
    expect(decodeChargeErrorReason("Error(Contract, #4)")).toBe(
      SubscriptionChargeErrorReason.AmountOutOfBounds
    );
  });
});

describe("SubscriptionExecutor multi-instance claiming (#394)", () => {
  // Emulates the columns a real Postgres claim UPDATE would serialize on: a
  // conditional claim succeeds only when the subscription is unclaimed or its
  // claim is older than the TTL, and exactly one concurrent caller can win.
  const subscriptionId = 4;
  const claims = new Map<number, { claimedAt: Date; claimedBy: string }>();

  beforeEach(() => {
    jest.clearAllMocks();
    claims.clear();
    mockedPrisma.donation.upsert.mockResolvedValue({ id: 1 });
    mockedPrisma.subscription.update.mockResolvedValue(subscription);
    mockedPrisma.$transaction.mockImplementation(
      async (callback: ((client: typeof mockedPrisma) => Promise<unknown>) | Promise<unknown>[]) => {
        if (typeof callback === "function") {
          return callback(mockedPrisma);
        }
        return Promise.all(callback);
      }
    );
    mockedRenewed.mockResolvedValue(undefined);
    mockedApplyToGoals.mockResolvedValue([]);
    mockedNotifyGoalsReached.mockResolvedValue(undefined);

    mockedPrisma.subscription.updateMany.mockImplementation(async (args: {
      where: {
        id: number;
        claimedBy?: string;
        OR?: { claimedAt: { lt: Date } | null }[];
      };
      data: { claimedAt: Date | null; claimedBy?: string | null };
    }) => {
      const { where, data } = args;
      const current = claims.get(where.id);

      if (data.claimedAt instanceof Date) {
        const expiredBefore = where.OR?.find(
          (clause) => clause.claimedAt && "lt" in clause.claimedAt
        )?.claimedAt as { lt: Date } | undefined;
        const claimable =
          !current ||
          (expiredBefore instanceof Object && current.claimedAt < expiredBefore.lt);
        if (!claimable) return { count: 0 };
        claims.set(where.id, {
          claimedAt: data.claimedAt,
          claimedBy: data.claimedBy as string,
        });
        return { count: 1 };
      }

      // Release: only the instance that still owns the claim may clear it.
      if (where.claimedBy && current?.claimedBy !== where.claimedBy) {
        return { count: 0 };
      }
      claims.delete(where.id);
      return { count: 1 };
    });
  });

  function executorWithCharge(submitCharge: jest.Mock): SubscriptionExecutor {
    const executor = new SubscriptionExecutor();
    (executor as unknown as { submitCharge: jest.Mock }).submitCharge = submitCharge;
    return executor;
  }

  it("submits exactly one charge when two executors tick concurrently", async () => {
    // Hold both findMany calls until both instances have loaded the due
    // subscription, so the two ticks genuinely overlap at the claim step
    // (simulating two backend instances, not the same instance's running flag).
    let findManyCalls = 0;
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    mockedPrisma.subscription.findMany.mockImplementation(async () => {
      findManyCalls += 1;
      if (findManyCalls === 2) openGate();
      await gate;
      return [subscription];
    });

    const submitCharge = jest.fn().mockResolvedValue("charge-tx");
    const first = executorWithCharge(submitCharge);
    const second = executorWithCharge(submitCharge);

    await Promise.all([first.tick(), second.tick()]);

    expect(mockedPrisma.subscription.findMany).toHaveBeenCalledTimes(2);
    expect(submitCharge).toHaveBeenCalledTimes(1);
    // The winning instance released its claim when the charge finished.
    expect(claims.has(subscriptionId)).toBe(false);
  });

  it("skips a subscription another live instance is still charging", async () => {
    claims.set(subscriptionId, {
      claimedAt: new Date(),
      claimedBy: "other-live-instance",
    });
    mockedPrisma.subscription.findMany.mockResolvedValue([subscription]);

    const submitCharge = jest.fn().mockResolvedValue("charge-tx");
    await executorWithCharge(submitCharge).tick();

    expect(submitCharge).not.toHaveBeenCalled();
    expect(claims.get(subscriptionId)?.claimedBy).toBe("other-live-instance");
  });

  it("reclaims and charges a subscription abandoned by a crashed instance after the TTL", async () => {
    claims.set(subscriptionId, {
      claimedAt: new Date(Date.now() - 10 * 60_000),
      claimedBy: "crashed-instance",
    });
    mockedPrisma.subscription.findMany.mockResolvedValue([subscription]);

    const submitCharge = jest.fn().mockResolvedValue("charge-tx");
    await executorWithCharge(submitCharge).tick();

    expect(submitCharge).toHaveBeenCalledTimes(1);
    expect(claims.has(subscriptionId)).toBe(false);
  });
});

describe("parseLastErrorReason (#283)", () => {
  it("recovers the reason encoded by recordFailure", () => {
    expect(
      parseLastErrorReason("InsufficientAllowance: Transaction abc failed on-chain")
    ).toBe(SubscriptionChargeErrorReason.InsufficientAllowance);
    expect(
      parseLastErrorReason("InsufficientBalance: Transaction abc failed on-chain")
    ).toBe(SubscriptionChargeErrorReason.InsufficientBalance);
  });

  it("returns undefined for a plain, undecorated lastError", () => {
    expect(parseLastErrorReason("Transaction abc failed on-chain")).toBeUndefined();
  });

  it("recovers the new #465 guardrail reasons too", () => {
    expect(
      parseLastErrorReason("TokenNotAllowed: Transaction abc failed on-chain")
    ).toBe(SubscriptionChargeErrorReason.TokenNotAllowed);
    expect(
      parseLastErrorReason("AmountOutOfBounds: Transaction abc failed on-chain")
    ).toBe(SubscriptionChargeErrorReason.AmountOutOfBounds);
  });

  it("returns undefined for null/undefined", () => {
    expect(parseLastErrorReason(null)).toBeUndefined();
    expect(parseLastErrorReason(undefined)).toBeUndefined();
  });
});
