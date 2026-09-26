import { RateLimiter } from "../../services/rateLimiter";

describe("RateLimiter", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("allows requests up to the configured maximum", () => {
    const limiter = new RateLimiter(3, 60_000);
    expect(limiter.attempt("a@example.com")).toBe(true);
    expect(limiter.attempt("a@example.com")).toBe(true);
    expect(limiter.attempt("a@example.com")).toBe(true);
  });

  it("rejects a request once the maximum is exceeded within the window", () => {
    const limiter = new RateLimiter(2, 60_000);
    expect(limiter.attempt("a@example.com")).toBe(true);
    expect(limiter.attempt("a@example.com")).toBe(true);
    expect(limiter.attempt("a@example.com")).toBe(false);
  });

  it("tracks each key independently", () => {
    const limiter = new RateLimiter(1, 60_000);
    expect(limiter.attempt("a@example.com")).toBe(true);
    expect(limiter.attempt("b@example.com")).toBe(true);
    expect(limiter.attempt("a@example.com")).toBe(false);
    expect(limiter.attempt("b@example.com")).toBe(false);
  });

  it("allows a request again once the window has elapsed", () => {
    jest.useFakeTimers();
    const limiter = new RateLimiter(1, 60_000);

    expect(limiter.attempt("a@example.com")).toBe(true);
    expect(limiter.attempt("a@example.com")).toBe(false);

    jest.advanceTimersByTime(60_001);

    expect(limiter.attempt("a@example.com")).toBe(true);
  });

  it("clear resets every key", () => {
    const limiter = new RateLimiter(1, 60_000);
    limiter.attempt("a@example.com");
    limiter.clear();
    expect(limiter.attempt("a@example.com")).toBe(true);
  });

  describe("retryAfterSeconds", () => {
    it("is 0 while the key is under its limit", () => {
      const limiter = new RateLimiter(2, 60_000);
      limiter.attempt("k");
      expect(limiter.retryAfterSeconds("k")).toBe(0);
    });

    it("reports the seconds until the oldest request leaves the window", () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const limiter = new RateLimiter(1, 60_000);
      limiter.attempt("k");
      jest.setSystemTime(new Date("2026-01-01T00:00:20Z"));
      expect(limiter.attempt("k")).toBe(false);
      expect(limiter.retryAfterSeconds("k")).toBe(40);
    });
  });
});
