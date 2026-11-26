import { TwitterStateStore } from "../../services/twitterStateStore";

const entry = (expiresAt = Date.now() + 60_000) => ({
  codeVerifier: "verifier",
  bindingHash: "binding-hash",
  expiresAt,
});

describe("TwitterStateStore (#438)", () => {
  it("consumes a state exactly once", () => {
    const store = new TwitterStateStore(10);

    store.set("state-1", entry());

    expect(store.consume("state-1")).toEqual({
      codeVerifier: "verifier",
      bindingHash: "binding-hash",
      expiresAt: expect.any(Number),
    });
    expect(store.consume("state-1")).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("treats an expired state as never issued and evicts it", () => {
    const store = new TwitterStateStore(10);
    store.set("state-1", entry(Date.now() - 1));

    expect(store.consume("state-1")).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("never grows past maxEntries, dropping the oldest states first", () => {
    const store = new TwitterStateStore(3);

    store.set("a", entry());
    store.set("b", entry());
    store.set("c", entry());
    store.set("d", entry());

    expect(store.size).toBe(3);
    expect(store.consume("a")).toBeUndefined();
    expect(store.consume("b")).toBeDefined();
    expect(store.consume("d")).toBeDefined();
  });

  it("sweeps expired states on demand", () => {
    const store = new TwitterStateStore(10);
    store.set("expired", entry(Date.now() - 1));
    store.set("live", entry(Date.now() + 60_000));

    expect(store.sweep()).toBe(1);
    expect(store.size).toBe(1);
    expect(store.consume("live")).toBeDefined();
  });

  it("sweeps expired states on a timer, with an unref'd timer", () => {
    jest.useFakeTimers();
    try {
      const store = new TwitterStateStore(10, 1_000);
      store.set("expired", entry(Date.now() - 1));

      store.startSweeping();
      jest.advanceTimersByTime(1_000);

      expect(store.size).toBe(0);
      store.stopSweeping();
    } finally {
      jest.useRealTimers();
    }
  });

  it("clear() empties the store", () => {
    const store = new TwitterStateStore(10);
    store.set("a", entry());

    store.clear();

    expect(store.size).toBe(0);
  });
});
