jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn().mockResolvedValue({ deletedAt: null }) },
    creator: {
      findUnique: jest.fn(),
    },
    goal: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  },
}));

jest.mock("../../services/donationNotifications", () => ({
  notifyGoalsReached: jest.fn().mockResolvedValue(undefined),
}));

import request from "supertest";
import app from "../../app";
import prisma from "../../prisma";
import { notifyGoalsReached } from "../../services/donationNotifications";
import { generateToken } from "../../middleware/auth";

const mockedNotifyGoalsReached = notifyGoalsReached as jest.Mock;

const mockedPrisma = prisma as unknown as {
  creator: { findUnique: jest.Mock };
  goal: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
};

describe("GET /api/goals/:username", () => {
  it("returns 404 when the creator does not exist", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue(null);

    const res = await request(app).get("/api/goals/missing");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("lists every goal for a creator (public, no auth required)", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, username: "bob" });
    const goals = [
      { id: 1, creatorId: 7, title: "New mic", targetAmount: 500, currentAmount: 120, currency: "XLM", status: "ACTIVE" },
      { id: 2, creatorId: 7, title: "Monthly support", targetAmount: 2000, currentAmount: 0, currency: "XLM", status: "ACTIVE", recurring: true },
    ];
    mockedPrisma.goal.findMany.mockResolvedValue(goals);

    const res = await request(app).get("/api/goals/bob");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: goals });
    expect(mockedPrisma.goal.findMany).toHaveBeenCalledWith({
      where: { creatorId: 7 },
      orderBy: { createdAt: "asc" },
    });
  });

  it("filters by status when provided", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, username: "bob" });
    mockedPrisma.goal.findMany.mockResolvedValue([]);

    await request(app).get("/api/goals/bob?status=COMPLETED");

    expect(mockedPrisma.goal.findMany).toHaveBeenCalledWith({
      where: { creatorId: 7, status: "COMPLETED" },
      orderBy: { createdAt: "asc" },
    });
  });
});

describe("POST /api/goals/:username", () => {
  const token = generateToken(1, "GUSERADDRESS");

  it("rejects requests without an auth token", async () => {
    const res = await request(app).post("/api/goals/bob").send({ targetAmount: 100 });
    expect(res.status).toBe(401);
  });

  it("rejects a non-positive targetAmount", async () => {
    const res = await request(app)
      .post("/api/goals/bob")
      .set("Authorization", `Bearer ${token}`)
      .send({ targetAmount: -5 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a recurring goal with no recurrenceInterval", async () => {
    const res = await request(app)
      .post("/api/goals/bob")
      .set("Authorization", `Bearer ${token}`)
      .send({ targetAmount: 100, recurring: true });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 when the creator does not exist", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/goals/missing")
      .set("Authorization", `Bearer ${token}`)
      .send({ targetAmount: 100 });

    expect(res.status).toBe(404);
  });

  it("rejects creating a goal on someone else's profile", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, userId: 2, username: "bob" });

    const res = await request(app)
      .post("/api/goals/bob")
      .set("Authorization", `Bearer ${token}`)
      .send({ targetAmount: 100 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
    expect(mockedPrisma.goal.create).not.toHaveBeenCalled();
  });

  it("creates a non-recurring goal with no currentPeriodEnd", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, userId: 1, username: "bob" });
    const created = { id: 1, creatorId: 7, title: "New mic", targetAmount: 500, currency: "XLM" };
    mockedPrisma.goal.create.mockResolvedValue(created);

    const res = await request(app)
      .post("/api/goals/bob")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "New mic", targetAmount: 500, currency: "XLM" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(created);
    expect(mockedPrisma.goal.create).toHaveBeenCalledWith({
      data: {
        creatorId: 7,
        title: "New mic",
        targetAmount: 500,
        currency: "XLM",
        recurring: false,
        recurrenceInterval: null,
        currentPeriodEnd: null,
      },
    });
  });

  it("stores an optional description with the goal", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, userId: 1, username: "bob" });
    mockedPrisma.goal.create.mockResolvedValue({ id: 4 });

    const res = await request(app)
      .post("/api/goals/bob")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Buy a new laptop", description: "For editing videos", targetAmount: 500 });

    expect(res.status).toBe(201);
    expect(mockedPrisma.goal.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ title: "Buy a new laptop", description: "For editing videos" }),
    });
  });

  it("rejects a description longer than 500 characters", async () => {
    const res = await request(app)
      .post("/api/goals/bob")
      .set("Authorization", `Bearer ${token}`)
      .send({ targetAmount: 100, description: "x".repeat(501) });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("creates a goal denominated in USDT (issue #18)", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, userId: 1, username: "bob" });
    const created = { id: 3, creatorId: 7, title: "Server costs", targetAmount: 300, currency: "USDT" };
    mockedPrisma.goal.create.mockResolvedValue(created);

    const res = await request(app)
      .post("/api/goals/bob")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Server costs", targetAmount: 300, currency: "USDT" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(created);
    expect(mockedPrisma.goal.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ currency: "USDT" }),
    });
  });

  it("creates a recurring monthly goal with a computed currentPeriodEnd ~30 days out", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, userId: 1, username: "bob" });
    mockedPrisma.goal.create.mockResolvedValue({ id: 2 });

    await request(app)
      .post("/api/goals/bob")
      .set("Authorization", `Bearer ${token}`)
      .send({ targetAmount: 2000, currency: "XLM", recurring: true, recurrenceInterval: "MONTHLY" });

    const call = mockedPrisma.goal.create.mock.calls[0][0];
    expect(call.data.recurring).toBe(true);
    expect(call.data.recurrenceInterval).toBe("MONTHLY");
    const deltaMs = call.data.currentPeriodEnd.getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect(deltaMs).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000);
  });
});

describe("PUT /api/goals/:id", () => {
  const token = generateToken(1, "GUSERADDRESS");

  it("rejects requests without an auth token", async () => {
    const res = await request(app).put("/api/goals/1").send({ status: "EXPIRED" });
    expect(res.status).toBe(401);
  });

  it("returns 404 when the goal does not exist", async () => {
    mockedPrisma.goal.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .put("/api/goals/1")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "EXPIRED" });

    expect(res.status).toBe(404);
  });

  it("rejects editing a goal that belongs to someone else's profile", async () => {
    mockedPrisma.goal.findUnique.mockResolvedValue({ id: 1, creator: { userId: 2 } });

    const res = await request(app)
      .put("/api/goals/1")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "EXPIRED" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
    expect(mockedPrisma.goal.update).not.toHaveBeenCalled();
  });

  it("allows the owner to mark a goal EXPIRED", async () => {
    mockedPrisma.goal.findUnique.mockResolvedValue({
      id: 1,
      creator: { userId: 1 },
      recurring: false,
      recurrenceInterval: null,
    });
    mockedPrisma.goal.update.mockResolvedValue({ id: 1, status: "EXPIRED" });

    const res = await request(app)
      .put("/api/goals/1")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "EXPIRED" });

    expect(res.status).toBe(200);
    expect(mockedPrisma.goal.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: "EXPIRED" },
    });
  });

  it("recomputes currentPeriodEnd when a goal is switched to recurring", async () => {
    mockedPrisma.goal.findUnique.mockResolvedValue({
      id: 1,
      creator: { userId: 1 },
      recurring: false,
      recurrenceInterval: null,
    });
    mockedPrisma.goal.update.mockResolvedValue({ id: 1 });

    await request(app)
      .put("/api/goals/1")
      .set("Authorization", `Bearer ${token}`)
      .send({ recurring: true, recurrenceInterval: "WEEKLY" });

    const call = mockedPrisma.goal.update.mock.calls[0][0];
    expect(call.data.recurring).toBe(true);
    expect(call.data.currentPeriodEnd).toBeInstanceOf(Date);
  });

  it("clears currentPeriodEnd when a goal is switched off recurring", async () => {
    mockedPrisma.goal.findUnique.mockResolvedValue({
      id: 1,
      creator: { userId: 1 },
      recurring: true,
      recurrenceInterval: "MONTHLY",
    });
    mockedPrisma.goal.update.mockResolvedValue({ id: 1 });

    await request(app)
      .put("/api/goals/1")
      .set("Authorization", `Bearer ${token}`)
      .send({ recurring: false });

    expect(mockedPrisma.goal.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { recurring: false, currentPeriodEnd: null },
    });
  });

  it("lets the owner edit a goal's title, description and target", async () => {
    mockedPrisma.goal.findUnique.mockResolvedValue({
      id: 1,
      creator: { userId: 1 },
      recurring: false,
      recurrenceInterval: null,
    });
    mockedPrisma.goal.update.mockResolvedValue({ id: 1 });

    const res = await request(app)
      .put("/api/goals/1")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Buy a new laptop", description: null, targetAmount: 750 });

    expect(res.status).toBe(200);
    expect(mockedPrisma.goal.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { title: "Buy a new laptop", description: null, targetAmount: 750 },
    });
  });

  it("completes an ACTIVE goal and sends one email when the target is lowered to the current amount (issue #442)", async () => {
    mockedPrisma.goal.findUnique.mockResolvedValue({
      id: 1,
      creator: { userId: 1 },
      currentAmount: 120,
      targetAmount: 500,
      recurring: false,
      status: "ACTIVE",
    });
    mockedPrisma.goal.update.mockResolvedValue({ id: 1, currentAmount: 120, targetAmount: 120, status: "COMPLETED" });

    const res = await request(app)
      .put("/api/goals/1")
      .set("Authorization", `Bearer ${token}`)
      .send({ targetAmount: 120 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("COMPLETED");
    expect(mockedPrisma.goal.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { targetAmount: 120, status: "COMPLETED" },
    });
    expect(mockedNotifyGoalsReached).toHaveBeenCalledTimes(1);
    expect(mockedNotifyGoalsReached).toHaveBeenCalledWith([
      { id: 1, currentAmount: 120, targetAmount: 120, status: "COMPLETED" },
    ]);
  });

  it("completes an ACTIVE goal when the target is lowered below the current amount (issue #442)", async () => {
    mockedPrisma.goal.findUnique.mockResolvedValue({
      id: 1,
      creator: { userId: 1 },
      currentAmount: 120,
      targetAmount: 500,
      recurring: false,
      status: "ACTIVE",
    });
    mockedPrisma.goal.update.mockResolvedValue({ id: 1, currentAmount: 120, targetAmount: 100, status: "COMPLETED" });

    const res = await request(app)
      .put("/api/goals/1")
      .set("Authorization", `Bearer ${token}`)
      .send({ targetAmount: 100 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("COMPLETED");
    expect(mockedNotifyGoalsReached).toHaveBeenCalledTimes(1);
  });

  it("leaves an ACTIVE goal alone when the lowered target is still above the current amount", async () => {
    mockedPrisma.goal.findUnique.mockResolvedValue({
      id: 1,
      creator: { userId: 1 },
      currentAmount: 120,
      targetAmount: 500,
      recurring: false,
      status: "ACTIVE",
    });
    mockedPrisma.goal.update.mockResolvedValue({ id: 1, currentAmount: 120, targetAmount: 200, status: "ACTIVE" });

    const res = await request(app)
      .put("/api/goals/1")
      .set("Authorization", `Bearer ${token}`)
      .send({ targetAmount: 200 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ACTIVE");
    expect(mockedPrisma.goal.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { targetAmount: 200 },
    });
    expect(mockedNotifyGoalsReached).not.toHaveBeenCalled();
  });

  it("does not complete a recurring goal when its target is lowered below the current amount", async () => {
    mockedPrisma.goal.findUnique.mockResolvedValue({
      id: 1,
      creator: { userId: 1 },
      currentAmount: 120,
      targetAmount: 500,
      recurring: true,
      recurrenceInterval: "MONTHLY",
      status: "ACTIVE",
    });
    mockedPrisma.goal.update.mockResolvedValue({ id: 1, currentAmount: 120, targetAmount: 100, status: "ACTIVE" });

    const res = await request(app)
      .put("/api/goals/1")
      .set("Authorization", `Bearer ${token}`)
      .send({ targetAmount: 100 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ACTIVE");
    expect(mockedPrisma.goal.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { targetAmount: 100 },
    });
    expect(mockedNotifyGoalsReached).not.toHaveBeenCalled();
  });

  it("rejects reopening a COMPLETED goal that is already at or above its target (issue #442)", async () => {
    mockedPrisma.goal.findUnique.mockResolvedValue({
      id: 1,
      creator: { userId: 1 },
      currentAmount: 120,
      targetAmount: 100,
      recurring: false,
      status: "COMPLETED",
    });

    const res = await request(app)
      .put("/api/goals/1")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "ACTIVE" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_REQUEST");
    expect(mockedPrisma.goal.update).not.toHaveBeenCalled();
    expect(mockedNotifyGoalsReached).not.toHaveBeenCalled();
  });

  it("rejects reopening an EXPIRED goal that is already at or above its target", async () => {
    mockedPrisma.goal.findUnique.mockResolvedValue({
      id: 1,
      creator: { userId: 1 },
      currentAmount: 120,
      targetAmount: 100,
      recurring: false,
      status: "EXPIRED",
    });

    const res = await request(app)
      .put("/api/goals/1")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "ACTIVE" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("BAD_REQUEST");
    expect(mockedPrisma.goal.update).not.toHaveBeenCalled();
  });

  it("allows reopening a COMPLETED goal that is still below its target", async () => {
    mockedPrisma.goal.findUnique.mockResolvedValue({
      id: 1,
      creator: { userId: 1 },
      currentAmount: 50,
      targetAmount: 100,
      recurring: false,
      status: "COMPLETED",
    });
    mockedPrisma.goal.update.mockResolvedValue({ id: 1, currentAmount: 50, targetAmount: 100, status: "ACTIVE" });

    const res = await request(app)
      .put("/api/goals/1")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "ACTIVE" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ACTIVE");
    expect(mockedPrisma.goal.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: "ACTIVE" },
    });
    expect(mockedNotifyGoalsReached).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/goals/:id", () => {
  const token = generateToken(1, "GUSERADDRESS");

  it("rejects requests without an auth token", async () => {
    const res = await request(app).delete("/api/goals/1");
    expect(res.status).toBe(401);
  });

  it("returns 404 when the goal does not exist", async () => {
    mockedPrisma.goal.findUnique.mockResolvedValue(null);

    const res = await request(app).delete("/api/goals/1").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it("rejects deleting a goal that belongs to someone else's profile", async () => {
    mockedPrisma.goal.findUnique.mockResolvedValue({ id: 1, creator: { userId: 2 } });

    const res = await request(app).delete("/api/goals/1").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
    expect(mockedPrisma.goal.delete).not.toHaveBeenCalled();
  });

  it("allows the owner to delete a goal", async () => {
    mockedPrisma.goal.findUnique.mockResolvedValue({ id: 1, creator: { userId: 1 } });
    mockedPrisma.goal.delete.mockResolvedValue({ id: 1 });

    const res = await request(app).delete("/api/goals/1").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(mockedPrisma.goal.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });
});
