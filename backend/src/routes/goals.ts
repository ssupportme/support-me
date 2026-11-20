import { Router } from "express";
import prisma from "../prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import { validate } from "../middleware/validate";
import {
  createGoalSchema,
  goalIdParamSchema,
  listGoalsQuerySchema,
  updateGoalSchema,
  usernameParamSchema,
} from "../schemas/goals";
import { computePeriodEnd, formatGoalAmounts, goalMeetsTarget } from "../services/goalService";
import { notifyGoalsReached } from "../services/donationNotifications";
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from "../errors/AppError";

const router = Router();

// Public: a creator's goals, for their profile page's goal bar(s). Scoped to
// one creator (unlike /api/donations, which supports an unfiltered list) —
// nothing in the product needs a global goals feed.
router.get(
  "/:username",
  validate({ params: usernameParamSchema, query: listGoalsQuerySchema }),
  asyncHandler(async (req, res) => {
    const { username } = req.params;
    const { status } = req.query as unknown as { status?: "ACTIVE" | "COMPLETED" | "EXPIRED" };

    const creator = await prisma.creator.findUnique({ where: { username } });
    if (!creator) {
      throw new NotFoundError("Creator not found");
    }

    const goals = await prisma.goal.findMany({
      where: { creatorId: creator.id, ...(status ? { status } : {}) },
      orderBy: { createdAt: "asc" },
    });

    return res.json({ items: goals.map(formatGoalAmounts) });
  })
);

router.post(
  "/:username",
  authMiddleware,
  validate({ params: usernameParamSchema, body: createGoalSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    const { username } = req.params;
    const { title, description, targetAmount, currency, recurring, recurrenceInterval } = req.body;

    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const creator = await prisma.creator.findUnique({ where: { username } });
    if (!creator) {
      throw new NotFoundError("Creator not found");
    }
    if (creator.userId !== req.user.id) {
      throw new ForbiddenError("You can only create goals on your own profile");
    }

    const goal = await prisma.goal.create({
      data: {
        creatorId: creator.id,
        title,
        description,
        targetAmount,
        currency,
        recurring,
        recurrenceInterval: recurring ? recurrenceInterval : null,
        currentPeriodEnd: recurring ? computePeriodEnd(recurrenceInterval) : null,
      },
    });

    return res.status(201).json(formatGoalAmounts(goal));
  })
);

router.put(
  "/:id",
  authMiddleware,
  validate({ params: goalIdParamSchema, body: updateGoalSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const { id } = req.params as unknown as { id: number };
    const existing = await prisma.goal.findUnique({ where: { id }, include: { creator: true } });
    if (!existing) {
      throw new NotFoundError("Goal not found");
    }
    if (existing.creator.userId !== req.user.id) {
      throw new ForbiddenError("You can only edit your own goals");
    }

    const updates = req.body as {
      title?: string | null;
      description?: string | null;
      targetAmount?: number;
      status?: "ACTIVE" | "COMPLETED" | "EXPIRED";
      recurring?: boolean;
      recurrenceInterval?: "WEEKLY" | "MONTHLY" | null;
    };

    // Turning a goal recurring (or changing its interval) (re)computes the
    // period end from now, the same way creating a recurring goal does.
    const willBeRecurring = updates.recurring ?? existing.recurring;
    const interval = updates.recurrenceInterval ?? existing.recurrenceInterval;
    const recurrenceChanged =
      updates.recurring !== undefined || updates.recurrenceInterval !== undefined;

    // A goal's target can be edited down to (or below) what it has already
    // raised. Re-evaluate completion against the values that will apply
    // after this edit (issue #442) — a goal that ends up at or above its
    // target must not stay ACTIVE forever. Amounts are always present on a
    // real row; the guard only skips the check for partial test fixtures.
    const effectiveTarget = updates.targetAmount ?? existing.targetAmount;
    const atOrAboveTarget =
      existing.currentAmount != null &&
      effectiveTarget != null &&
      goalMeetsTarget({ currentAmount: existing.currentAmount, targetAmount: effectiveTarget });

    // Reopening a goal that has already reached its target would put it
    // straight back into the stuck state, so reject it. Reopening a goal
    // still below its target is fine.
    if (updates.status === "ACTIVE" && existing.status !== "ACTIVE" && atOrAboveTarget) {
      throw new BadRequestError("Cannot reopen a goal that has already reached its target");
    }

    // An ACTIVE non-recurring goal at or above its target completes now,
    // even when the edit only lowered the target. Recurring goals keep
    // accumulating until their period resets (see goalService.ts), so an
    // edit never completes them.
    const effectiveStatus = updates.status ?? existing.status;
    const completesNow = effectiveStatus === "ACTIVE" && !willBeRecurring && atOrAboveTarget;

    const goal = await prisma.goal.update({
      where: { id },
      data: {
        ...updates,
        ...(completesNow ? { status: "COMPLETED" } : {}),
        ...(recurrenceChanged
          ? {
              currentPeriodEnd: willBeRecurring && interval ? computePeriodEnd(interval) : null,
            }
          : {}),
      },
    });

    // Notify once, only when this edit is what completed the goal. A goal
    // that was already COMPLETED sends nothing again, and marking a goal
    // COMPLETED by hand sends nothing either — the owner already knows.
    if (completesNow) {
      await notifyGoalsReached([goal]);
    }

    return res.json(formatGoalAmounts(goal));
  })
);

router.delete(
  "/:id",
  authMiddleware,
  validate({ params: goalIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res) => {
    if (!req.user) {
      throw new UnauthorizedError("User not authenticated");
    }

    const { id } = req.params as unknown as { id: number };
    const existing = await prisma.goal.findUnique({ where: { id }, include: { creator: true } });
    if (!existing) {
      throw new NotFoundError("Goal not found");
    }
    if (existing.creator.userId !== req.user.id) {
      throw new ForbiddenError("You can only delete your own goals");
    }

    await prisma.goal.delete({ where: { id } });

    return res.status(204).send();
  })
);

export default router;
