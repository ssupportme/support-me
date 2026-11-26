jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {
    emailEvent: {
      create: jest.fn(),
    },
  },
}));

import { Prisma } from "@prisma/client";
import { createHmac } from "crypto";
import request from "supertest";
import app from "../../app";
import prisma from "../../prisma";

const mockedPrisma = prisma as unknown as {
  emailEvent: { create: jest.Mock };
};

const WEBHOOK_SECRET = "whsec_dGVzdHNlY3JldGtleWZvcnRlc3Rpbmc="; // base64 payload after the whsec_ prefix

function signPayload(payload: string, msgId: string, timestamp: number) {
  const secretBytes = Buffer.from(WEBHOOK_SECRET.split("_")[1], "base64");
  const toSign = `${msgId}.${timestamp}.${payload}`;
  const signature = createHmac("sha256", secretBytes).update(toSign).digest("base64");
  return {
    "svix-id": msgId,
    "svix-timestamp": timestamp.toString(),
    "svix-signature": `v1,${signature}`,
  };
}

function postWebhook(payload: object) {
  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = signPayload(body, "msg_test123", timestamp);

  return request(app)
    .post("/api/webhooks/email/resend")
    .set("Content-Type", "application/json")
    .set(headers)
    .send(body);
}

describe("POST /api/webhooks/email/resend", () => {
  const originalSecret = process.env.RESEND_WEBHOOK_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;
    mockedPrisma.emailEvent.create.mockResolvedValue({});
  });

  afterAll(() => {
    process.env.RESEND_WEBHOOK_SECRET = originalSecret;
  });

  it("records a BOUNCED event for a validly signed email.bounced payload", async () => {
    const res = await postWebhook({
      type: "email.bounced",
      data: {
        email_id: "resend-abc",
        to: ["supporter@example.com"],
        subject: "Your subscription renewed",
        bounce: { message: "mailbox does not exist" },
      },
    });

    expect(res.status).toBe(200);
    expect(mockedPrisma.emailEvent.create).toHaveBeenCalledWith({
      data: {
        recipient: "supporter@example.com",
        subject: "Your subscription renewed",
        type: "BOUNCED",
        providerMessageId: "resend-abc",
        svixId: "msg_test123",
        errorDetail: "mailbox does not exist",
      },
    });
  });

  it("records one BOUNCED event per recipient of a multi-recipient message (#534)", async () => {
    const res = await postWebhook({
      type: "email.bounced",
      data: {
        email_id: "resend-multi",
        to: ["first@example.com", "Second@Example.com"],
        subject: "Your subscription renewed",
        bounce: { message: "mailbox does not exist" },
      },
    });

    expect(res.status).toBe(200);
    expect(mockedPrisma.emailEvent.create).toHaveBeenCalledTimes(2);
    expect(mockedPrisma.emailEvent.create).toHaveBeenNthCalledWith(1, {
      data: {
        recipient: "first@example.com",
        subject: "Your subscription renewed",
        type: "BOUNCED",
        providerMessageId: "resend-multi",
        errorDetail: "mailbox does not exist",
      },
    });
    expect(mockedPrisma.emailEvent.create).toHaveBeenNthCalledWith(2, {
      data: {
        recipient: "second@example.com",
        subject: "Your subscription renewed",
        type: "BOUNCED",
        providerMessageId: "resend-multi",
        errorDetail: "mailbox does not exist",
      },
    });
  });

  it("normalizes a mixed-case recipient to lowercase before storing it (#534)", async () => {
    const res = await postWebhook({
      type: "email.bounced",
      data: {
        email_id: "resend-case",
        to: ["Bob@X.com"],
        subject: "Receipt",
        bounce: { message: "mailbox does not exist" },
      },
    });

    expect(res.status).toBe(200);
    expect(mockedPrisma.emailEvent.create).toHaveBeenCalledWith({
      data: {
        recipient: "bob@x.com",
        subject: "Receipt",
        type: "BOUNCED",
        providerMessageId: "resend-case",
        errorDetail: "mailbox does not exist",
      },
    });
  });

  it("acknowledges a verified payload with no data object instead of throwing (#534)", async () => {
    const res = await postWebhook({ type: "email.bounced" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    expect(mockedPrisma.emailEvent.create).not.toHaveBeenCalled();
  });

  it("records a DELIVERED event for a validly signed email.delivered payload", async () => {
    const res = await postWebhook({
      type: "email.delivered",
      data: { email_id: "resend-def", to: ["supporter@example.com"], subject: "Receipt" },
    });

    expect(res.status).toBe(200);
    expect(mockedPrisma.emailEvent.create).toHaveBeenCalledWith({
      data: {
        recipient: "supporter@example.com",
        subject: "Receipt",
        type: "DELIVERED",
        providerMessageId: "resend-def",
        svixId: "msg_test123",
        errorDetail: undefined,
      },
    });
  });

  it("acknowledges a retried delivery without inserting a duplicate row", async () => {
    const rows: Array<{ svixId: string }> = [];
    mockedPrisma.emailEvent.create.mockImplementation(
      async ({ data }: { data: { svixId: string } }) => {
        if (rows.some((row) => row.svixId === data.svixId)) {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "test",
          });
        }
        rows.push(data);
        return {};
      },
    );
    const payload = {
      type: "email.delivered",
      data: { email_id: "resend-retry", to: ["supporter@example.com"], subject: "Receipt" },
    };

    const first = await postWebhook(payload);
    const retry = await postWebhook(payload);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(rows).toHaveLength(1);
    expect(mockedPrisma.emailEvent.create).toHaveBeenCalledTimes(2);
  });

  it("acknowledges but does not record an event type it doesn't act on", async () => {
    const res = await postWebhook({
      type: "email.sent",
      data: { email_id: "resend-ghi", to: ["supporter@example.com"], subject: "Receipt" },
    });

    expect(res.status).toBe(200);
    expect(mockedPrisma.emailEvent.create).not.toHaveBeenCalled();
  });

  it("rejects a payload with an invalid signature", async () => {
    const body = JSON.stringify({
      type: "email.bounced",
      data: { to: ["supporter@example.com"] },
    });

    const res = await request(app)
      .post("/api/webhooks/email/resend")
      .set("Content-Type", "application/json")
      .set({
        "svix-id": "msg_test123",
        "svix-timestamp": Math.floor(Date.now() / 1000).toString(),
        "svix-signature": "v1,not-a-real-signature",
      })
      .send(body);

    expect(res.status).toBe(400);
    expect(mockedPrisma.emailEvent.create).not.toHaveBeenCalled();
  });

  it("rejects when the webhook secret is not configured", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;

    const res = await postWebhook({
      type: "email.bounced",
      data: { to: ["supporter@example.com"] },
    });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
    expect(mockedPrisma.emailEvent.create).not.toHaveBeenCalled();
  });


  it("rejects an unsigned payload when the secret is configured", async () => {
    const res = await request(app)
      .post("/api/webhooks/email/resend")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ type: "email.bounced", data: { to: ["supporter@example.com"] } }));

    expect(res.status).toBe(400);
    expect(mockedPrisma.emailEvent.create).not.toHaveBeenCalled();
  });
});
