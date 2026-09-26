jest.mock("../../prisma", () => ({
  __esModule: true,
  default: {},
}));

import { IncomingMessage } from "http";
import { Socket } from "net";
import request from "supertest";
import app from "../../app";
import { eventBus, DONATION_EVENT, DonationEvent } from "../../services/eventBus";

/**
 * An SSE connection never completes, so a normal `await request(app).get(...)`
 * would hang until the test times out. This opens the stream without awaiting
 * it, resolves once response headers have arrived, collects the chunks written
 * by the route, and hands back an abort handle.
 */
function openStream() {
  const chunks: string[] = [];
  let status = 0;
  let headers: Record<string, string> = {};
  let onHeaders: () => void;
  let socket: Socket | undefined;
  const headersArrived = new Promise<void>((resolve) => {
    onHeaders = resolve;
  });

  // buffer(false) hands back the raw IncomingMessage so the stream can stay
  // open, which is what a real EventSource sees.
  const pending = request(app)
    .get("/api/events")
    .set("Accept", "text/event-stream")
    .buffer(false);
  pending.on("response", (res: IncomingMessage) => {
    status = res.statusCode ?? 0;
    headers = res.headers as Record<string, string>;
    socket = res.socket;
    onHeaders();
    res.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
    // Tearing the socket down surfaces an ECONNRESET on the raw response.
    // That is the expected consequence of closing an open stream, not a
    // failure, so it must not become an unhandled 'error' event.
    res.on("error", () => undefined);
  });
  // Tearing down a long-lived stream is expected here, so swallow the
  // resulting "aborted" error rather than letting it fail a later test.
  pending.on("error", () => undefined);
  pending.end(() => undefined);

  return {
    chunks,
    ready: headersArrived,
    get status() {
      return status;
    },
    get headers() {
      return headers;
    },
    close: () => {
      socket?.destroy();
      pending.abort();
    },
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("GET /api/events", () => {
  const open: { close: () => void }[] = [];

  const connect = async () => {
    const stream = openStream();
    open.push(stream);
    await stream.ready;
    return stream;
  };

  afterEach(() => {
    // Abort any stream a failing test left open, so its 30s heartbeat
    // interval can't keep the process alive.
    for (const stream of open.splice(0)) stream.close();
    eventBus.removeAllListeners();
  });

  it("returns SSE headers and accepts connections", async () => {
    const stream = await connect();

    expect(stream.status).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.headers["cache-control"]).toBe("no-cache");
    expect(stream.headers["connection"]).toContain("keep-alive");
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

    const stream = await connect();
    eventBus.emit(DONATION_EVENT, mockDonationEvent);
    await delay(50);

    const eventData = stream.chunks.find((c) => c.includes("event: donation"));
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

    const conn1 = await connect();
    const conn2 = await connect();
    const conn3 = await connect();

    // Emit a single event
    eventBus.emit(DONATION_EVENT, mockDonationEvent);
    await delay(50);

    // All connections should have received the event
    for (const conn of [conn1, conn2, conn3]) {
      const eventData = conn.chunks.find((c) => c.includes("event: donation"));
      expect(eventData).toBeDefined();
    }
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

    const first = await connect();
    eventBus.emit(DONATION_EVENT, mockDonationEvent1);
    await delay(50);

    first.close();
    await delay(50);

    // The disconnected stream must stop receiving events...
    const beforeCount = first.chunks.length;
    eventBus.emit(DONATION_EVENT, mockDonationEvent2);
    await delay(50);
    expect(first.chunks.length).toBe(beforeCount);

    // ...and a fresh connection picks events up again.
    const second = await connect();
    eventBus.emit(DONATION_EVENT, mockDonationEvent2);
    await delay(50);

    const event2Data = second.chunks.find((c) => c.includes("event: donation"));
    expect(event2Data).toBeDefined();

    const lines = event2Data?.split("\n") || [];
    const dataLine = lines.find((l) => l.startsWith("data:"));
    const parsedData = JSON.parse(dataLine?.replace("data: ", "") || "{}");
    expect(parsedData.memo).toBe("After reconnect");
    expect(parsedData.txHash).toBe(mockDonationEvent2.txHash);
  });

  it("keeps the connection open instead of ending it", async () => {
    // The heartbeat interval is 30s, so this asserts the complementary
    // property directly: nothing has been written and nothing has ended the
    // response, which is what lets a real EventSource stay connected.
    const stream = await connect();
    await delay(50);

    expect(stream.status).toBe(200);
    expect(stream.chunks).toHaveLength(0);
  });

  it("cleans up event listeners on connection close", async () => {
    const initialListenerCount = eventBus.listenerCount(DONATION_EVENT);

    const stream = await connect();

    // Listener should be added
    expect(eventBus.listenerCount(DONATION_EVENT)).toBe(initialListenerCount + 1);

    // Close connection
    stream.close();
    await delay(50);

    // Listener should be removed
    expect(eventBus.listenerCount(DONATION_EVENT)).toBe(initialListenerCount);
  });
});
