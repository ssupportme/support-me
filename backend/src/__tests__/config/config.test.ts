import { MissingEnvError, assertRequiredEnv, getAllowedOrigins, getJwtSecret } from "../../config";

describe("required env validation (#178)", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalJwtSecret = process.env.JWT_SECRET;
  const originalCorsOrigins = process.env.CORS_ALLOWED_ORIGINS;

  beforeEach(() => {
    process.env.NODE_ENV = "production";
    delete process.env.JWT_SECRET;
  });

  afterAll(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
    if (originalCorsOrigins === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = originalCorsOrigins;
  });

  it("refuses to start in production when JWT_SECRET is absent", () => {
    expect(() => assertRequiredEnv()).toThrow(MissingEnvError);
    expect(() => assertRequiredEnv()).toThrow(/JWT_SECRET/);
  });

  it("rejects a blank or whitespace-only JWT_SECRET rather than signing with it", () => {
    process.env.JWT_SECRET = "   ";
    expect(() => getJwtSecret()).toThrow(MissingEnvError);
  });

  it("starts normally once JWT_SECRET is configured", () => {
    process.env.JWT_SECRET = "a-real-configured-secret";
    expect(() => assertRequiredEnv()).not.toThrow();
    expect(getJwtSecret()).toBe("a-real-configured-secret");
  });

  it("trims surrounding whitespace from a configured secret", () => {
    process.env.JWT_SECRET = "  padded-secret  ";
    expect(getJwtSecret()).toBe("padded-secret");
  });

  it("no hardcoded fallback secret is reachable in a non-test code path", () => {
    expect(() => getJwtSecret()).toThrow();
    // The historical default must not be usable as a signing key anywhere.
    expect(process.env.JWT_SECRET).toBeUndefined();
  });

  it("mints and verifies tokens without a configured secret under NODE_ENV=test", () => {
    process.env.NODE_ENV = "test";
    const secret = getJwtSecret();
    expect(secret).toBeTruthy();
    // Stable within the process so signed and verified tokens agree.
    expect(getJwtSecret()).toBe(secret);
    expect(secret).not.toBe("your-secret-key");
  });
});

describe("CORS origin allowlist (#179)", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalCorsOrigins = process.env.CORS_ALLOWED_ORIGINS;

  beforeEach(() => {
    process.env.NODE_ENV = "production";
    delete process.env.CORS_ALLOWED_ORIGINS;
  });

  afterAll(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalCorsOrigins === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = originalCorsOrigins;
  });

  it("defaults to allowing no browser origin in production when unconfigured", () => {
    expect(getAllowedOrigins()).toEqual([]);
  });

  it("includes the local frontend origins outside production", () => {
    process.env.NODE_ENV = "development";
    expect(getAllowedOrigins()).toContain("http://localhost:3000");
  });

  it("parses a comma-separated allowlist and trims whitespace and trailing slashes", () => {
    process.env.CORS_ALLOWED_ORIGINS =
      " https://support-mee.vercel.app/ , https://support-me-git-main.vercel.app ";
    expect(getAllowedOrigins()).toEqual([
      "https://support-mee.vercel.app",
      "https://support-me-git-main.vercel.app",
    ]);
  });

  it("ignores empty entries in the allowlist", () => {
    process.env.CORS_ALLOWED_ORIGINS = "https://a.example,,  ,https://b.example";
    expect(getAllowedOrigins()).toEqual(["https://a.example", "https://b.example"]);
  });

  it("de-duplicates repeated origins", () => {
    process.env.CORS_ALLOWED_ORIGINS = "https://a.example,https://a.example/";
    expect(getAllowedOrigins()).toEqual(["https://a.example"]);
  });
});
