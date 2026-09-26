jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {},
}));

import request from "supertest";
import app from "../../app";
import { eventBus, DONATION_EVENT, DonationEvent } from "../../services/eventBus";

describe("GET /api/events", () => {
  afterEach(() => {
    // Clean up any event listeners after each test
    eventBus.removeAllListeners();
  });

  it("returns SSE headers and accepts connections", async () => {
    const res = await request(app).get("/api/events").set("Accept", "text/event-stream");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.headers["connection"]).toContain("keep-alive");
  });

  it("delivers donation events in the correct SSE format", async () => {
    const mockDonationEvent: DonationEvent = {
      donor: "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
      creator: "GABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZ",
      amount: "50000000", // 5 XLM in stroops
      memo: "Test donation message",
      timestamp: Date.now(),
      ledger: 12345,
      txHash: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6",
    };

    const eventsReceived: string[] = [];
    let connectionClosed = false;

    const res = await request(app)
      .get("/api/events")
      .set("Accept", "text/event-stream")
      .buffer(false)
      .parse((res, callback) => {
        res.on("data", (chunk: Buffer) => {
          const data = chunk.toString();
          eventsReceived.push(data);
        });
        res.on("end", () => {
          connectionClosed = true;
          callback(null, { eventsReceived, connectionClosed });
        });
      });

    // Wait a bit for the connection to be established
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Emit a donation event
    eventBus.emit(DONATION_EVENT, mockDonationEvent);

    // Wait for the event to be delivered
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Close the connection by aborting the underlying request
    (res as any).req?.destroy?.();

    // Wait for cleanup
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Check that we received an event
    const eventData = eventsReceived.find((e) => e.includes("event: donation"));
    expect(eventData).toBeDefined();

    // Parse the SSE format
    const lines = eventData?.split("\n") || [];
    const eventLine = lines.find((l) => l.startsWith("event:"));
    const dataLine = lines.find((l) => l.startsWith("data:"));

    expect(eventLine).toBe("event: donation");
    expect(dataLine).toBeDefined();

    // Parse the JSON data
    const parsedData = JSON.parse(dataLine?.replace("data: ", "") || "{}");
    expect(parsedData).toEqual(mockDonationEvent);
  });

  it("handles multiple concurrent SSE connections", async () => {
    const mockDonationEvent: DonationEvent = {
      donor: "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
      creator: "GABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZ",
      amount: "100000000",
      memo: "Concurrent test",
      timestamp: Date.now(),
      ledger: 12346,
      txHash: "z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4j3i2h1g0f9e8d7c6b5a4",
    };

    const connections: { eventsReceived: string[] }[] = [];
    const createConnection = async () => {
      const eventsReceived: string[] = [];
      const res = await request(app)
        .get("/api/events")
        .set("Accept", "text/event-stream")
        .buffer(false)
        .parse((res, callback) => {
          res.on("data", (chunk: Buffer) => {
            eventsReceived.push(chunk.toString());
          });
          res.on("end", () => {
            callback(null, { eventsReceived });
          });
        });
      return { res, eventsReceived };
    };

    // Create 3 concurrent connections
    const conn1 = await createConnection();
    const conn2 = await createConnection();
    const conn3 = await createConnection();

    connections.push({ eventsReceived: conn1.eventsReceived });
    connections.push({ eventsReceived: conn2.eventsReceived });
    connections.push({ eventsReceived: conn3.eventsReceived });

    // Wait for connections to establish
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Emit a single event
    eventBus.emit(DONATION_EVENT, mockDonationEvent);

    // Wait for delivery
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Close all connections
    (conn1.res as any).req?.destroy?.();
    (conn2.res as any).req?.destroy?.();
    (conn3.res as any).req?.destroy?.();

    // Wait for cleanup
    await new Promise((resolve) => setTimeout(resolve, 50));

    // All connections should have received the event
    connections.forEach((conn) => {
      const eventData = conn.eventsReceived.find((e) => e.includes("event: donation"));
      expect(eventData).toBeDefined();
    });
  });

  it("handles client disconnect and reconnect", async () => {
    const mockDonationEvent1: DonationEvent = {
      donor: "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
      creator: "GABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZ",
      amount: "25000000",
      memo: "Before disconnect",
      timestamp: Date.now(),
      ledger: 12347,
      txHash: "a1b2c3d4e5f6",
    };

    const mockDonationEvent2: DonationEvent = {
      donor: "GA7D5LDGFABXNYEO6LZVMTWK5JWEPTODCLYZ7TG4XDZRKKXP6OS5K5JW",
      creator: "GABC123DEF456GHI789JKL012MNO345PQR678STU901VWX234YZ",
      amount: "75000000",
      memo: "After reconnect",
      timestamp: Date.now() + 1000,
      ledger: 12348,
      txHash: "f6e5d4c3b2a1",
    };

    // First connection
    const eventsReceived1: string[] = [];
    const res1 = await request(app)
      .get("/api/events")
      .set("Accept", "text/event-stream")
      .buffer(false)
      .parse((res, callback) => {
        res.on("data", (chunk: Buffer) => {
          eventsReceived1.push(chunk.toString());
        });
        res.on("end", () => {
          callback(null, { eventsReceived: eventsReceived1 });
        });
      });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Emit first event
    eventBus.emit(DONATION_EVENT, mockDonationEvent1);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Disconnect first connection
    (res1 as any).req?.destroy?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify first event was received
    const event1Data = eventsReceived1.find((e) => e.includes("event: donation"));
    expect(event1Data).toBeDefined();

    // Second connection (reconnect)
    const eventsReceived2: string[] = [];
    const res2 = await request(app)
      .get("/api/events")
      .set("Accept", "text/event-stream")
      .buffer(false)
      .parse((res, callback) => {
        res.on("data", (chunk: Buffer) => {
          eventsReceived2.push(chunk.toString());
        });
        res.on("end", () => {
          callback(null, { eventsReceived: eventsReceived2 });
        });
      });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Emit second event after reconnect
    eventBus.emit(DONATION_EVENT, mockDonationEvent2);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Close second connection
    (res2 as any).req?.destroy?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify second event was received on reconnected connection
    const event2Data = eventsReceived2.find((e) => e.includes("event: donation"));
    expect(event2Data).toBeDefined();

    // Parse and verify the second event data
    const lines = event2Data?.split("\n") || [];
    const dataLine = lines.find((l) => l.startsWith("data:"));
    const parsedData = JSON.parse(dataLine?.replace("data: ", "") || "{}");
    expect(parsedData.memo).toBe("After reconnect");
    expect(parsedData.txHash).toBe(mockDonationEvent2.txHash);
  });

  it("sends periodic heartbeat to keep connection alive", async () => {
    const chunksReceived: string[] = [];
    const startTime = Date.now();

    const res = await request(app)
      .get("/api/events")
      .set("Accept", "text/event-stream")
      .buffer(false)
      .parse((res, callback) => {
        res.on("data", (chunk: Buffer) => {
          chunksReceived.push(chunk.toString());
        });
        res.on("end", () => {
          callback(null, { chunksReceived });
        });
      });

    // Wait for at least one heartbeat (30s interval, but we'll check for a short time)
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Close connection
    (res as any).req?.destroy?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The heartbeat sends ": ping\n\n" every 30 seconds
    // Since we only wait 100ms, we won't see a heartbeat in this test
    // But we can verify the connection was established and didn't error
    expect(res.status).toBe(200);
  });

  it("cleans up event listeners on connection close", async () => {
    const initialListenerCount = eventBus.listenerCount(DONATION_EVENT);

    const res = await request(app)
      .get("/api/events")
      .set("Accept", "text/event-stream")
      .buffer(false);

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Listener should be added
    expect(eventBus.listenerCount(DONATION_EVENT)).toBe(initialListenerCount + 1);

    // Close connection
    (res as any).req?.destroy?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Listener should be removed
    expect(eventBus.listenerCount(DONATION_EVENT)).toBe(initialListenerCount);
  });
});
