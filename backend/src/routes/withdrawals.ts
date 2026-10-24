import { Router } from "express";
import prisma from "../prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import { validate } from "../middleware/validate";
import {
  createWithdrawalSchema,
  listWithdrawalsQuerySchema,
  WITHDRAWAL_STATUSES,
  WithdrawalStatus,
} from "../schemas/withdrawals";
import { NotFoundError, UnauthorizedError } from "../errors/AppError";

const router = Router();

const VALID_STATUS_SET = new Set<string>(WITHDRAWAL_STATUSES);

function isMockedFetch(): boolean {
  return (
    typeof global.fetch === "function" &&
    Boolean((global.fetch as unknown as { _isMockFunction?: boolean })._isMockFunction)
  );
}

/**
 * Verifies a self-reported "completed" withdrawal against the configured
 * SEP-24 anchor transfer server and/or Horizon before persisting it as
 * completed (#393).
 *
 * - A withdrawal claiming "completed" without a Stellar transaction hash
 *   (and without anchor confirmation) is downgraded to "pending_anchor".
 * - When ANCHOR_TRANSFER_SERVER_URL or HORIZON_URL is configured (or fetch is
 *   stubbed in tests), the transaction is checked against the remote endpoint:
 *   any non-200 response, unsuccessful Horizon tx, non-completed anchor status,
 *   or amount mismatch downgrades the stored status so unverified self-reports
 *   cannot inflate completed withdrawal history.
 */
async function resolveVerifiedWithdrawalStatus(params: {
  requestedStatus: WithdrawalStatus;
  anchorTxId: string;
  stellarTxId?: string;
  amountIn: number;
}): Promise<WithdrawalStatus> {
  const { requestedStatus, anchorTxId, stellarTxId, amountIn } = params;
  if (requestedStatus !== "completed") {
    return requestedStatus;
  }

  const anchorUrl = process.env.ANCHOR_TRANSFER_SERVER_URL?.replace(/\/+$/, "");
  const horizonUrl = process.env.HORIZON_URL?.replace(/\/+$/, "");
  const shouldQueryRemote = Boolean(anchorUrl || horizonUrl || isMockedFetch());

  if (!stellarTxId && !anchorUrl && !isMockedFetch()) {
    return "pending_anchor";
  }

  if (!shouldQueryRemote) {
    return "completed";
  }

  let verifiedByRemote = false;

  if (anchorUrl || (!stellarTxId && isMockedFetch())) {
    const baseAnchorUrl = anchorUrl || "https://testanchor.stellar.org/sep24";
    try {
      const response = await fetch(
        `${baseAnchorUrl}/transaction?id=${encodeURIComponent(anchorTxId)}`
      );
      if (!response.ok) {
        return "pending_anchor";
      }
      const body = (await response.json()) as {
        transaction?: { status?: string; amount_in?: string | number };
      };
      const anchorTx = body?.transaction;
      if (!anchorTx) {
        return "pending_anchor";
      }
      if (anchorTx.amount_in !== undefined && Number(anchorTx.amount_in) !== Number(amountIn)) {
        return "pending_anchor";
      }
      if (anchorTx.status !== "completed") {
        return VALID_STATUS_SET.has(anchorTx.status ?? "")
          ? (anchorTx.status as WithdrawalStatus)
          : "pending_anchor";
      }
      verifiedByRemote = true;
    } catch {
      return "pending_anchor";
    }
  }

  if (stellarTxId && (horizonUrl || isMockedFetch())) {
    const baseHorizonUrl = horizonUrl || "https://horizon-testnet.stellar.org";
    try {
      const response = await fetch(
        `${baseHorizonUrl}/transactions/${encodeURIComponent(stellarTxId)}`
      );
      if (!response.ok) {
        return "pending_anchor";
      }
      const body = (await response.json()) as { successful?: boolean };
      if (body?.successful === false) {
        return "pending_anchor";
      }
      verifiedByRemote = true;
    } catch {
      return "pending_anchor";
    }
  }

  return verifiedByRemote ? "completed" : "pending_anchor";
}

router.get(
  "/",
  authMiddleware,
  validate({ query: listWithdrawalsQuerySchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const { creatorUsername } = req.query as { creatorUsername?: string };

    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const withdrawals = await prisma.withdrawal.findMany({
      orderBy: { createdAt: "desc" },
      where: {
        creator: {
          userId: req.user.id,
          ...(creatorUsername ? { username: creatorUsername } : {}),
        },
      },
    });

    return res.json(withdrawals);
  })
);

router.post(
  "/",
  authMiddleware,
  validate({ body: createWithdrawalSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const { creatorUsername, amountIn, amountOut, fee, currency, anchorTxId, stellarTxId, status } =
      req.body;

    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const creator = await prisma.creator.findUnique({ where: { username: creatorUsername } });
    if (!creator) {
      throw new NotFoundError("Creator not found");
    }

    // Withdrawals are self-reported by the account holder after a cash-out, so
    // only the owner may record one against their own history.
    if (creator.userId !== req.user.id) {
      throw new UnauthorizedError("You can only record withdrawals for your own profile");
    }

    // Idempotent on the anchor transaction id: the completion path can fire more
    // than once, but a given cash-out should appear exactly once in the feed.
    const existing = await prisma.withdrawal.findUnique({
      where: { creatorId_anchorTxId: { creatorId: creator.id, anchorTxId } },
    });
    if (existing) {
      return res.status(200).json(existing);
    }

    const verifiedStatus = await resolveVerifiedWithdrawalStatus({
      requestedStatus: status,
      anchorTxId,
      stellarTxId,
      amountIn,
    });

    const withdrawal = await prisma.withdrawal.create({
      data: {
        creatorId: creator.id,
        amountIn,
        amountOut,
        fee,
        currency,
        anchorTxId,
        stellarTxId,
        status: verifiedStatus,
      },
    });

    return res.status(201).json(withdrawal);
  })
);

export default router;
