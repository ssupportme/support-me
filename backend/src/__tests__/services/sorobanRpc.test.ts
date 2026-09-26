import { rpc } from "@stellar/stellar-sdk";
import {
  callSorobanRpc,
  getSorobanRpcUrls,
  resetSorobanRpcFailoverState,
  withSorobanRpcFailover,
  withSorobanRpcServer,
} from "../../services/sorobanRpc";

describe("Soroban RPC failover", () => {
  const originalUrls = process.env.SOROBAN_RPC_URLS;
  const originalEndpoints = process.env.SOROBAN_RPC_ENDPOINTS;
  const originalUrl = process.env.SOROBAN_RPC_URL;
  const originalTimeout = process.env.SOROBAN_RPC_TIMEOUT_MS;
  const originalFetch = global.fetch;

  beforeEach(() => {
    resetSorobanRpcFailoverState();
    delete process.env.SOROBAN_RPC_URLS;
    delete process.env.SOROBAN_RPC_ENDPOINTS;
    delete process.env.SOROBAN_RPC_URL;
    delete process.env.SOROBAN_RPC_TIMEOUT_MS;
    jest.spyOn(console, "info").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterAll(() => {
    global.fetch = originalFetch;
    if (originalUrls === undefined) delete process.env.SOROBAN_RPC_URLS;
    else process.env.SOROBAN_RPC_URLS = originalUrls;
    if (originalEndpoints === undefined) delete process.env.SOROBAN_RPC_ENDPOINTS;
    else process.env.SOROBAN_RPC_ENDPOINTS = originalEndpoints;
    if (originalUrl === undefined) delete process.env.SOROBAN_RPC_URL;
    else process.env.SOROBAN_RPC_URL = originalUrl;
    if (originalTimeout === undefined) delete process.env.SOROBAN_RPC_TIMEOUT_MS;
    else process.env.SOROBAN_RPC_TIMEOUT_MS = originalTimeout;
    jest.restoreAllMocks();
  });

  it("parses, trims, and de-duplicates plural endpoints", () => {
    process.env.SOROBAN_RPC_URLS =
      " https://primary.example/rpc, https://secondary.example/rpc,https://primary.example/rpc ";

    expect(getSorobanRpcUrls()).toEqual([
      "https://primary.example/rpc",
      "https://secondary.example/rpc",
    ]);
  });

  it("keeps the legacy singular endpoint setting working", () => {
    process.env.SOROBAN_RPC_URL = "https://legacy.example/rpc";

    expect(getSorobanRpcUrls()).toEqual(["https://legacy.example/rpc"]);
  });

  it("retries a failing primary and uses the next endpoint", async () => {
    process.env.SOROBAN_RPC_URLS = "https://primary.example/rpc,https://secondary.example/rpc";
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error("primary unavailable"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ result: { sequence: 42 } }),
      }) as unknown as typeof fetch;

    await expect(callSorobanRpc<{ sequence: number }>("getLatestLedger", {})).resolves.toEqual({
      sequence: 42,
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe("https://primary.example/rpc");
    expect((global.fetch as jest.Mock).mock.calls[1][0]).toBe("https://secondary.example/rpc");
  });

  it("keeps using the fallback after it has served a request", async () => {
    process.env.SOROBAN_RPC_URLS = "https://primary.example/rpc,https://secondary.example/rpc";
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error("primary unavailable"))
      .mockResolvedValue({
        ok: true,
        json: async () => ({ result: { sequence: 42 } }),
      }) as unknown as typeof fetch;

    await callSorobanRpc("getLatestLedger", {});
    await callSorobanRpc("getLatestLedger", {});

    expect((global.fetch as jest.Mock).mock.calls[1][0]).toBe("https://secondary.example/rpc");
  });

  it("applies the same failover policy to Stellar SDK server operations", async () => {
    process.env.SOROBAN_RPC_URLS = "https://primary.example/rpc,https://secondary.example/rpc";
    const getHealth = jest
      .spyOn(rpc.Server.prototype, "getHealth")
      .mockRejectedValueOnce(new Error("primary unavailable"))
      .mockResolvedValueOnce({ status: "healthy" } as never);

    await expect(
      withSorobanRpcServer("sdkOperation", (server) => server.getHealth())
    ).resolves.toEqual({ status: "healthy" });
    expect(getHealth).toHaveBeenCalledTimes(2);
  });

  it("reports an aggregate error when every endpoint fails", async () => {
    process.env.SOROBAN_RPC_URLS = "https://primary.example/rpc,https://secondary.example/rpc";
    const operation = jest.fn().mockRejectedValue(new Error("offline"));

    await expect(
      withSorobanRpcFailover("testOperation", operation, { timeoutMs: 20 })
    ).rejects.toThrow("failed on all configured endpoints");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("fails over when an endpoint operation times out", async () => {
    process.env.SOROBAN_RPC_URLS = "https://primary.example/rpc,https://secondary.example/rpc";
    const operation = jest
      .fn()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce("ok");

    await expect(
      withSorobanRpcFailover("testTimeout", operation, {
        // Generous real-timer windows: on a loaded machine a 5ms budget can
        // fire after the second endpoint has already resolved and flakily
        // report "failed on all configured endpoints".
        timeoutMs: 50,
        totalTimeoutMs: 500,
      })
    ).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
  });
});

describe("Soroban RPC retry with backoff (#27)", () => {
  const originalUrls = process.env.SOROBAN_RPC_URLS;
  const originalFetch = global.fetch;

  beforeEach(() => {
    resetSorobanRpcFailoverState();
    process.env.SOROBAN_RPC_URLS = "https://primary.example/rpc";
    jest.spyOn(console, "info").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterAll(() => {
    global.fetch = originalFetch;
    if (originalUrls === undefined) delete process.env.SOROBAN_RPC_URLS;
    else process.env.SOROBAN_RPC_URLS = originalUrls;
    jest.restoreAllMocks();
  });

  it("recovers from a transient RPC failure without surfacing an error", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: "Service Unavailable" })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { sequence: 7 } }) }) as unknown as typeof fetch;

    await expect(callSorobanRpc<{ sequence: number }>("getLatestLedger", {})).resolves.toEqual({
      sequence: 7,
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("recovers from a dropped connection", async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error("read ECONNRESET"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { sequence: 8 } }) }) as unknown as typeof fetch;

    await expect(callSorobanRpc<{ sequence: number }>("getLatestLedger", {})).resolves.toEqual({
      sequence: 8,
    });
  });

  it("does not retry a contract revert, failing on the first attempt", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: { message: "HostError: Error(Contract, #42)", code: -32000 } }),
    }) as unknown as typeof fetch;

    await expect(callSorobanRpc("sendTransaction", {})).rejects.toThrow(
      "failed on all configured endpoints"
    );
    // One endpoint, one attempt: a revert is a final answer from the chain.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry an invalid-params JSON-RPC error", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: { message: "invalid params", code: -32602 } }),
    }) as unknown as typeof fetch;

    await expect(callSorobanRpc("sendTransaction", {})).rejects.toThrow(
      "failed on all configured endpoints"
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("gives up after exhausting its retries on a persistent outage", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable" }) as unknown as typeof fetch;

    await expect(
      callSorobanRpc("getLatestLedger", {}, { retries: 2, retryBaseDelayMs: 1 })
    ).rejects.toThrow("failed on all configured endpoints");
    // 1 initial attempt + 2 retries, each against the single endpoint.
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it("retries SDK operations after a transient failure", async () => {
    process.env.SOROBAN_RPC_URLS = "https://primary.example/rpc";
    const getHealth = jest
      .spyOn(rpc.Server.prototype, "getHealth")
      .mockRejectedValueOnce(new Error("HTTP 503 Service Unavailable"))
      .mockResolvedValue({ status: "healthy" } as never);

    await expect(
      withSorobanRpcServer("sdkHealth", (server) => server.getHealth(), {
        totalTimeoutMs: 500,
      })
    ).resolves.toEqual({ status: "healthy" });
    expect(getHealth).toHaveBeenCalledTimes(2);
  });

  it("makes exactly one attempt against the SDK for a permanent error", async () => {
    process.env.SOROBAN_RPC_URLS = "https://primary.example/rpc";
    const sendTransaction = jest
      .spyOn(rpc.Server.prototype, "sendTransaction")
      .mockRejectedValue(new Error("HostError: Error(Contract, #7)"));

    await expect(
      withSorobanRpcServer("sendTransaction", (server) => server.sendTransaction({} as never))
    ).rejects.toThrow("failed on all configured endpoints");
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });
});
