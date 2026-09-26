import {
  classifySorobanError,
  isTransientSorobanError,
  withRetry,
} from "../../services/retry";

/** Deterministic stand-in for the backoff sleep so tests don't wait. */
const fakeSleep = () => Promise.resolve();
const noJitter = () => 1;

describe("Soroban RPC error classification (#27)", () => {
  it.each([
    ["a socket timeout", new Error("request timed out after 10000ms")],
    ["a connection reset", new Error("read ECONNRESET")],
    ["a refused connection", new Error("connect ECONNREFUSED 127.0.0.1:443")],
    ["a DNS lookup failure", new Error("getaddrinfo EAI_AGAIN rpc.example")],
    ["an aborted fetch", new Error("fetch failed")],
    ["a rate limit", new Error("HTTP 429 Too Many Requests")],
    ["an overloaded gateway", new Error("HTTP 502 Bad Gateway")],
    ["a temporarily unavailable node", new Error("HTTP 503 Service Unavailable")],
    ["a gateway timeout", new Error("HTTP 504 Gateway Timeout")],
  ])("treats %s as transient", (_label, error) => {
    expect(classifySorobanError(error)).toBe("transient");
  });

  it.each([
    ["a contract revert", new Error("HostError: Error(Contract, #1)")],
    ["a contract panic", new Error("contract panicked with an error")],
    ["invalid params", new Error("JSON-RPC error: invalid params")],
    ["a bad request", new Error("HTTP 400 Bad Request")],
    ["a forbidden request", new Error("HTTP 403 Forbidden")],
    ["insufficient funds", new Error("insufficient balance for fee")],
    ["an unknown method", new Error("method not found")],
  ])("treats %s as permanent", (_label, error) => {
    expect(classifySorobanError(error)).toBe("permanent");
  });

  it("classifies by JSON-RPC server-error codes", () => {
    expect(classifySorobanError({ code: -32603, message: "internal" })).toBe("transient");
    expect(classifySorobanError({ code: -32000, message: "server error" })).toBe("transient");
  });

  it("classifies JSON-RPC client-error codes as permanent", () => {
    expect(classifySorobanError({ code: -32602, message: "invalid params" })).toBe("permanent");
    expect(classifySorobanError({ code: -32601, message: "method not found" })).toBe("permanent");
  });

  it("prefers the permanent reading when a message hints at both", () => {
    // A revert delivered over a connection that also timed out must not be
    // retried — the chain already gave a final answer.
    expect(classifySorobanError(new Error("timeout while evaluating contract"))).toBe("permanent");
  });

  it("fails fast on an error it cannot classify", () => {
    expect(isTransientSorobanError(new Error("something entirely novel"))).toBe(false);
  });
});

describe("withRetry (#27)", () => {
  it("returns the first successful result without sleeping", async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const operation = jest.fn().mockResolvedValue("ok");

    await expect(withRetry("op", operation, { sleep, random: noJitter })).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a transient failure and succeeds without surfacing an error", async () => {
    const operation = jest
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 503 Service Unavailable"))
      .mockResolvedValue("recovered");

    await expect(
      withRetry("sendTransaction", operation, { sleep: fakeSleep, random: noJitter })
    ).resolves.toBe("recovered");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("backs off exponentially between attempts", async () => {
    const delays: number[] = [];
    const sleep = jest.fn(async (ms: number) => {
      delays.push(ms);
    });
    const operation = jest.fn().mockRejectedValue(new Error("fetch failed"));

    await expect(
      withRetry("getLedger", operation, {
        retries: 3,
        baseDelayMs: 100,
        sleep,
        random: noJitter,
      })
    ).rejects.toThrow("fetch failed");

    // Each successive delay is larger than the last.
    expect(delays).toHaveLength(3);
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
  });

  it("caps a single backoff delay at maxDelayMs", async () => {
    const delays: number[] = [];
    const sleep = jest.fn(async (ms: number) => {
      delays.push(ms);
    });
    const operation = jest.fn().mockRejectedValue(new Error("fetch failed"));

    await expect(
      withRetry("op", operation, {
        retries: 5,
        baseDelayMs: 1_000,
        maxDelayMs: 2_000,
        sleep,
        random: noJitter,
      })
    ).rejects.toThrow();

    for (const delay of delays) expect(delay).toBeLessThanOrEqual(2_000);
  });

  it("does not retry a permanent failure", async () => {
    const operation = jest.fn().mockRejectedValue(new Error("HostError: Error(Contract, #1)"));

    await expect(
      withRetry("sendTransaction", operation, { sleep: fakeSleep, random: noJitter })
    ).rejects.toThrow("HostError");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once the total timeout would be exceeded", async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const operation = jest.fn().mockRejectedValue(new Error("HTTP 503 Service Unavailable"));

    await expect(
      withRetry("op", operation, {
        retries: 5,
        baseDelayMs: 10_000,
        totalTimeoutMs: 50,
        sleep,
        random: noJitter,
      })
    ).rejects.toThrow("HTTP 503");

    // The budget is smaller than the first backoff, so it fails immediately
    // rather than sleeping past its own deadline.
    expect(sleep).not.toHaveBeenCalled();
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured number of retries", async () => {
    const operation = jest.fn().mockRejectedValue(new Error("ECONNRESET"));

    await expect(
      withRetry("op", operation, { retries: 2, sleep: fakeSleep, random: noJitter })
    ).rejects.toThrow("ECONNRESET");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does not retry at all when retries is 0", async () => {
    const operation = jest.fn().mockRejectedValue(new Error("ECONNRESET"));

    await expect(
      withRetry("op", operation, { retries: 0, sleep: fakeSleep })
    ).rejects.toThrow("ECONNRESET");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("passes the attempt number to the operation", async () => {
    const seen: number[] = [];
    const operation = jest.fn(async (attempt: number) => {
      seen.push(attempt);
      if (attempt < 2) throw new Error("fetch failed");
      return "ok";
    });

    await expect(
      withRetry("op", operation, { sleep: fakeSleep, random: noJitter })
    ).resolves.toBe("ok");
    expect(seen).toEqual([0, 1, 2]);
  });

  it("logs every retry attempt with its reason and delay", async () => {
    const log = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    const operation = jest
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 503 Service Unavailable"))
      .mockResolvedValue("ok");

    await withRetry("sendTransaction", operation, {
      sleep: fakeSleep,
      random: noJitter,
      baseDelayMs: 250,
    });

    const output = log.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Retrying transient Soroban RPC failure");
    expect(output).toContain("sendTransaction");
    expect(output).toContain("503");
    expect(output).toContain("delayMs");
    log.mockRestore();
  });
});
