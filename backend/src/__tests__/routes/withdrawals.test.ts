jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    user: { findUnique: jest.fn().mockResolvedValue({ deletedAt: null }) },
    creator: {
      findUnique: jest.fn(),
    },
    withdrawal: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  },
}));

import request from "supertest";
import app from "../../app";
import prisma from "../../prisma";
import { generateToken } from "../../middleware/auth";

const mockedPrisma = prisma as unknown as {
  creator: { findUnique: jest.Mock };
  withdrawal: { findMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock };
};

describe("GET /api/withdrawals", () => {
  const token = generateToken(1, "GUSERADDRESS");

  it("rejects anonymous requests", async () => {
    const res = await request(app).get("/api/withdrawals");

    expect(res.status).toBe(401);
    expect(mockedPrisma.withdrawal.findMany).not.toHaveBeenCalled();
  });

  it("returns only the authenticated user's withdrawals", async () => {
    const withdrawals = [{ id: 1, creatorId: 1, amountIn: 5, currency: "USDC" }];
    mockedPrisma.withdrawal.findMany.mockResolvedValue(withdrawals);

    const res = await request(app)
      .get("/api/withdrawals")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(withdrawals);
    expect(mockedPrisma.withdrawal.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: "desc" },
      where: { creator: { userId: 1 } },
    });
  });

  it("filters by creatorUsername when provided as a query param", async () => {
    mockedPrisma.withdrawal.findMany.mockResolvedValue([]);

    await request(app)
      .get("/api/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .query({ creatorUsername: "bob" });

    expect(mockedPrisma.withdrawal.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: "desc" },
      where: { creator: { userId: 1, username: "bob" } },
    });
  });
});

describe("POST /api/withdrawals", () => {
  const token = generateToken(1, "GUSERADDRESS");

  it("rejects requests without an auth token", async () => {
    const res = await request(app)
      .post("/api/withdrawals")
      .send({ creatorUsername: "bob", amountIn: 10, anchorTxId: "tx-1" });

    expect(res.status).toBe(401);
  });

  it("rejects a request missing required fields with a validation error", async () => {
    const res = await request(app)
      .post("/api/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .send({ amountIn: 10 });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 when the target creator does not exist", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .send({ creatorUsername: "unknown", amountIn: 10, anchorTxId: "tx-1" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("rejects recording a withdrawal for a profile the user does not own", async () => {
    // Token is for userId 1; this profile belongs to userId 2.
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 9, userId: 2, username: "bob" });

    const res = await request(app)
      .post("/api/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .send({ creatorUsername: "bob", amountIn: 10, anchorTxId: "tx-1" });

    expect(res.status).toBe(401);
    expect(mockedPrisma.withdrawal.create).not.toHaveBeenCalled();
  });

  it("creates a withdrawal for the owning creator", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, userId: 1, username: "bob" });
    mockedPrisma.withdrawal.findUnique.mockResolvedValue(null);
    const created = {
      id: 1,
      creatorId: 7,
      amountIn: 10,
      amountOut: 9.5,
      currency: "USDC",
      anchorTxId: "tx-1",
      status: "completed",
    };
    mockedPrisma.withdrawal.create.mockResolvedValue(created);

    const res = await request(app)
      .post("/api/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .send({
        creatorUsername: "bob",
        amountIn: 10,
        amountOut: 9.5,
        fee: 0.5,
        anchorTxId: "tx-1",
        stellarTxId: "stellar-1",
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(created);
    expect(mockedPrisma.withdrawal.create).toHaveBeenCalledWith({
      data: {
        creatorId: 7,
        amountIn: 10,
        amountOut: 9.5,
        fee: 0.5,
        currency: "USDC",
        anchorTxId: "tx-1",
        stellarTxId: "stellar-1",
        status: "completed",
      },
    });
  });

  it("is idempotent: a duplicate anchorTxId returns the existing record", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, userId: 1, username: "bob" });
    const existing = { id: 1, creatorId: 7, amountIn: 10, anchorTxId: "tx-1" };
    mockedPrisma.withdrawal.findUnique.mockResolvedValue(existing);

    const res = await request(app)
      .post("/api/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .send({ creatorUsername: "bob", amountIn: 10, anchorTxId: "tx-1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(existing);
    expect(mockedPrisma.withdrawal.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown/free-form withdrawal status with 400 VALIDATION_ERROR (#393)", async () => {
    const res = await request(app)
      .post("/api/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .send({
        creatorUsername: "bob",
        amountIn: 10,
        anchorTxId: "tx-invalid-status",
        status: "arbitrary_free_form_status",
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(mockedPrisma.withdrawal.create).not.toHaveBeenCalled();
  });

  it("downgrades a self-reported completed withdrawal without stellarTxId or anchor confirmation to pending_anchor (#393)", async () => {
    mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, userId: 1, username: "bob" });
    mockedPrisma.withdrawal.findUnique.mockResolvedValue(null);
    mockedPrisma.withdrawal.create.mockImplementation(async ({ data }) => ({ id: 2, ...data }));

    const res = await request(app)
      .post("/api/withdrawals")
      .set("Authorization", `Bearer ${token}`)
      .send({
        creatorUsername: "bob",
        amountIn: 500,
        anchorTxId: "unverified-anchor-tx",
      });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending_anchor");
    expect(mockedPrisma.withdrawal.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        creatorId: 7,
        amountIn: 500,
        anchorTxId: "unverified-anchor-tx",
        status: "pending_anchor",
      }),
    });
  });

  it("downgrades status to pending_anchor when Horizon does not confirm the stellarTxId (#393)", async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    try {
      mockedPrisma.creator.findUnique.mockResolvedValue({ id: 7, userId: 1, username: "bob" });
      mockedPrisma.withdrawal.findUnique.mockResolvedValue(null);
      mockedPrisma.withdrawal.create.mockImplementation(async ({ data }) => ({ id: 3, ...data }));

      const res = await request(app)
        .post("/api/withdrawals")
        .set("Authorization", `Bearer ${token}`)
        .send({
          creatorUsername: "bob",
          amountIn: 25,
          anchorTxId: "tx-unconfirmed",
          stellarTxId: "missing-on-horizon",
          status: "completed",
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("pending_anchor");
      expect(mockedPrisma.withdrawal.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          anchorTxId: "tx-unconfirmed",
          stellarTxId: "missing-on-horizon",
          status: "pending_anchor",
        }),
      });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
