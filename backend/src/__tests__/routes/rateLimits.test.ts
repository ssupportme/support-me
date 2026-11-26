jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    user: { upsert: jest.fn() },
    creator: { findUnique: jest.fn() },
  },
}));

jest.mock("../../services/magicLink", () => ({
  requestMagicLink: jest.fn(),
  verifyMagicLink: jest.fn(),
}));

jest.mock("../../services/twitterAuth", () => ({
  startTwitterAuth: jest.fn(),
  completeTwitterAuth: jest.fn(),
}));

import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import app from "../../app";
import prisma from "../../prisma";
import { completeTwitterAuth, startTwitterAuth } from "../../services/twitterAuth";
import {
  challenges,
  challengeIpLimiter,
  challengeWalletLimiter,
  verifyIpLimiter,
  verifyWalletLimiter,
  magicLinkIpLimiter,
  magicLinkEmailLimiter,
  twitterStartIpLimiter,
  twitterCallbackIpLimiter,
} from "../../routes/auth";
import { donationIpLimiter, donationSenderLimiter } from "../../routes/donations";

const mockedPrisma = prisma as unknown as { $transaction: jest.Mock };

const wallet = () => Keypair.random().publicKey();

beforeEach(() => {
  for (const limiter of [
    challengeIpLimiter,
    challengeWalletLimiter,
    verifyIpLimiter,
    verifyWalletLimiter,
    magicLinkIpLimiter,
    magicLinkEmailLimiter,
    twitterStartIpLimiter,
    twitterCallbackIpLimiter,
    donationIpLimiter,
    donationSenderLimiter,
  ]) {
    limiter.clear();
  }
  challenges.clear();
  mockedPrisma.$transaction.mockReset();
});

describe("POST /api/auth/challenge rate limiting (#180)", () => {
  it("rejects a wallet past 5 challenges a minute with 429 and Retry-After", async () => {
    const walletAddress = wallet();
    for (let i = 0; i < 5; i++) {
      const ok = await request(app).post("/api/auth/challenge").send({ walletAddress });
      expect(ok.status).toBe(200);
    }

    const res = await request(app).post("/api/auth/challenge").send({ walletAddress });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe("TOO_MANY_REQUESTS");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(res.body.error ?? res.body.message).toMatch(/retry in \d+ seconds/i);
  });

  it("limits a single IP across different wallets (30 a minute)", async () => {
    for (let i = 0; i < 30; i++) {
      const ok = await request(app).post("/api/auth/challenge").send({ walletAddress: wallet() });
      expect(ok.status).toBe(200);
    }

    const res = await request(app).post("/api/auth/challenge").send({ walletAddress: wallet() });

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("does not grow the challenge store past the limit for one wallet", async () => {
    const walletAddress = wallet();
    for (let i = 0; i < 8; i++) {
      await request(app).post("/api/auth/challenge").send({ walletAddress });
    }
    expect(challenges.size).toBe(1);
  });
});

describe("POST /api/auth/verify rate limiting (#180)", () => {
  it("rejects a wallet past 10 verification attempts a minute with 429", async () => {
    const walletAddress = wallet();
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post("/api/auth/verify")
        .send({ walletAddress, signedMessage: "AAAA" });
      expect(res.status).toBe(401); // no challenge issued: rejected, but counted
    }

    const res = await request(app)
      .post("/api/auth/verify")
      .send({ walletAddress, signedMessage: "AAAA" });

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });
});

describe("POST /api/auth/magic-link rate limiting (#25)", () => {
  it("rejects an email past 5 requests with 429 and Retry-After", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post("/api/auth/magic-link")
        .send({ email: "User@Example.com" });
      expect(res.status).toBe(200);
    }

    const res = await request(app)
      .post("/api/auth/magic-link")
      .send({ email: "user@example.com" });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe("TOO_MANY_REQUESTS");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(res.body.error).toMatch(/retry in \d+ seconds/i);
  });
});

describe("GET /api/auth/twitter rate limiting (#438)", () => {
  it("rejects starting a sign-in past 30 a minute from one IP with 429 and Retry-After", async () => {
    (startTwitterAuth as jest.Mock).mockReturnValue({
      redirectUrl: "https://twitter.com/i/oauth2/authorize?state=s",
      bindingNonce: "nonce",
    });
    for (let i = 0; i < 30; i++) {
      const ok = await request(app).get("/api/auth/twitter");
      expect(ok.status).toBe(200);
    }

    const res = await request(app).get("/api/auth/twitter");

    expect(res.status).toBe(429);
    expect(res.body.code).toBe("TOO_MANY_REQUESTS");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(res.body.error).toMatch(/retry in \d+ seconds/i);
  });

  it("rejects callbacks past 30 a minute from one IP, even when invalid", async () => {
    (completeTwitterAuth as jest.Mock).mockResolvedValue({
      user: { id: 1, walletAddress: null },
      token: "signed.jwt.token",
      hasProfile: false,
    });

    for (let i = 0; i < 30; i++) {
      const res = await request(app)
        .get("/api/auth/twitter/callback")
        .query({ code: "auth-code", state: "state-value" });
      expect(res.status).not.toBe(429);
    }

    const res = await request(app)
      .get("/api/auth/twitter/callback")
      .query({ code: "auth-code", state: "state-value" });

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("counts a malformed callback against the IP limit too", async () => {
    for (let i = 0; i < 30; i++) {
      const res = await request(app).get("/api/auth/twitter/callback");
      expect(res.status).toBe(400); // rejected by validation, but still counted
    }

    const res = await request(app).get("/api/auth/twitter/callback");

    expect(res.status).toBe(429);
  });
});

describe("POST /api/donations rate limiting (#180)", () => {
  const body = (senderAddress: string) => ({
    creatorUsername: "alice",
    senderAddress,
    amount: 5,
    transactionHash: "tx-rate-limit",
  });

  it("rejects a sender past 20 donation requests a minute with 429", async () => {
    mockedPrisma.$transaction.mockRejectedValue(new Error("db down"));
    const senderAddress = wallet();
    for (let i = 0; i < 20; i++) {
      const res = await request(app)
        .post("/api/donations")
        .set("Idempotency-Key", `key-${i}`)
        .send(body(senderAddress));
      expect(res.status).not.toBe(429);
    }

    const res = await request(app)
      .post("/api/donations")
      .set("Idempotency-Key", "key-over")
      .send(body(senderAddress));

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    // Rejected before any database work happens.
    expect(mockedPrisma.$transaction).toHaveBeenCalledTimes(20);
  });

  it("limits a single IP even when requests are invalid (60 a minute)", async () => {
    for (let i = 0; i < 60; i++) {
      const res = await request(app).post("/api/donations").send({});
      expect(res.status).toBe(400);
    }

    const res = await request(app).post("/api/donations").send({});

    expect(res.status).toBe(429);
  });
});
