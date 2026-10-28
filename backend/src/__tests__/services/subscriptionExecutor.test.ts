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
import {
  SubscriptionExecutor,
  SUBSCRIPTION_CLAIM_TTL_MS,
} from "../../services/subscriptionExecutor";
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

  it("returns undefined for null/undefined", () => {
    expect(parseLastErrorReason(null)).toBeUndefined();
    expect(parseLastErrorReason(undefined)).toBeUndefined();
  });
});

describe("SubscriptionExecutor multi-instance claim and expiry (#394)", () => {
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

  it("submits charge_subscription only once when two executor instances tick concurrently", async () => {
    let rowNextChargeAt = new Date(0);
    const rowActive = true;

    mockedPrisma.subscription.findMany.mockImplementation(async ({ where }) => {
      const cutoff: Date = where?.nextChargeAt?.lte ?? new Date();
      if (rowActive && rowNextChargeAt.getTime() <= cutoff.getTime()) {
        return [{ ...subscription, nextChargeAt: new Date(rowNextChargeAt) }];
      }
      return [];
    });

    mockedPrisma.subscription.updateMany.mockImplementation(async ({ where, data }) => {
      const cutoff: Date = where?.nextChargeAt?.lte ?? new Date();
      if (
        where?.id === subscription.id &&
        rowActive &&
        rowNextChargeAt.getTime() <= cutoff.getTime()
      ) {
        rowNextChargeAt = new Date(data.nextChargeAt);
        return { count: 1 };
      }
      return { count: 0 };
    });

    mockedPrisma.subscription.update.mockImplementation(async ({ data }) => {
      if (data.nextChargeAt) {
        rowNextChargeAt = new Date(data.nextChargeAt);
      }
      return { ...subscription, nextChargeAt: rowNextChargeAt };
    });

    const executorA = new SubscriptionExecutor();
    const executorB = new SubscriptionExecutor();
    const submitA = jest.fn().mockResolvedValue("tx-from-a");
    const submitB = jest.fn().mockResolvedValue("tx-from-b");
    (executorA as unknown as ExecutorTestAccess).submitCharge = submitA;
    (executorB as unknown as ExecutorTestAccess).submitCharge = submitB;

    await Promise.all([executorA.tick(), executorB.tick()]);

    expect(submitA.mock.calls.length + submitB.mock.calls.length).toBe(1);
    expect(mockedPrisma.subscription.updateMany).toHaveBeenCalledTimes(2);
  });

  it("allows a subsequent tick to re-claim and charge a subscription after an abandoned claim expires", async () => {
    const baseTime = new Date("2026-05-01T00:00:00.000Z");
    let currentTime = baseTime.getTime();
    const dateSpy = jest.spyOn(Date, "now").mockImplementation(() => currentTime);

    let rowNextChargeAt = new Date(baseTime.getTime() - 1_000);
    const rowActive = true;

    mockedPrisma.subscription.findMany.mockImplementation(async () => {
      if (rowActive && rowNextChargeAt.getTime() <= currentTime) {
        return [{ ...subscription, nextChargeAt: new Date(rowNextChargeAt) }];
      }
      return [];
    });

    mockedPrisma.subscription.updateMany.mockImplementation(async ({ data }) => {
      if (rowActive && rowNextChargeAt.getTime() <= currentTime) {
        rowNextChargeAt = new Date(data.nextChargeAt);
        return { count: 1 };
      }
      return { count: 0 };
    });

    // Simulate Instance 1 claiming the row and crashing before submitCharge/update finishes:
    rowNextChargeAt = new Date(currentTime + SUBSCRIPTION_CLAIM_TTL_MS);

    const recoveryExecutor = new SubscriptionExecutor();
    const submitRecovery = jest.fn().mockResolvedValue("tx-recovered");
    (recoveryExecutor as unknown as ExecutorTestAccess).submitCharge = submitRecovery;

    try {
      // Before lease expiry: tick sees no due subscription and does not double-charge.
      currentTime = baseTime.getTime() + SUBSCRIPTION_CLAIM_TTL_MS - 1_000;
      await recoveryExecutor.tick();
      expect(submitRecovery).not.toHaveBeenCalled();

      // After lease expiry: tick re-claims the expired lease and charges the subscription.
      currentTime = baseTime.getTime() + SUBSCRIPTION_CLAIM_TTL_MS + 1_000;
      rowNextChargeAt = new Date(Date.now() - 1_000);
      await recoveryExecutor.tick();
      expect(submitRecovery).toHaveBeenCalledTimes(1);
    } finally {
      dateSpy.mockRestore();
    }
  });
});
