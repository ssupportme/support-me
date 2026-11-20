import { randomBytes } from "crypto";
import { log } from "./lib/logger";
import { getStellarNetworkName } from "./services/stellarNetwork";

/**
 * Central configuration and validation for environment settings whose absence
 * would silently weaken security.
 *
 * Every getter is lazy (evaluated on call, never at import time) so importing
 * a module that touches config has no side effects and tests can vary the
 * environment per case.
 */

export const config = {
  // DONATION_CONTRACT_ID is the backend-scoped name (#302); NEXT_PUBLIC_
  // is a Next.js client-bundling prefix that means nothing server-side and
  // is misleading here. Falls back to the old NEXT_PUBLIC_-prefixed name for
  // backward compat with deployments that still have only that one set --
  // remove the fallback once those are confirmed migrated.
  get donationContractId() {
    return (
      process.env.DONATION_CONTRACT_ID?.trim() ||
      process.env.NEXT_PUBLIC_DONATION_CONTRACT_ID?.trim() ||
      ""
    );
  },
  get creatorRegistryContractId() { return process.env.NEXT_PUBLIC_CREATOR_REGISTRY_CONTRACT_ID?.trim() || ""; },
  get executorSecretKey() { return process.env.EXECUTOR_SECRET_KEY?.trim() || ""; },
  get databaseUrl() { return process.env.DATABASE_URL?.trim() || ""; },
  get jwtSecret() { return process.env.JWT_SECRET?.trim() || ""; },
  get appUrl() { return process.env.APP_URL?.trim() || ""; },
  get resendApiKey() { return process.env.RESEND_API_KEY?.trim() || ""; },
  get cloudinaryCloudName() { return process.env.CLOUDINARY_CLOUD_NAME?.trim() || ""; },
};

export interface RateLimitConfig {
  auth: {
    windowMs: number;
    ipMax: number;
    challengeAccountMax: number;
    verifyAccountMax: number;
  };
  donation: {
    windowMs: number;
    ipMax: number;
    accountMax: number;
  };
  magicLink: {
    windowMs: number;
    ipMax: number;
    accountMax: number;
  };
  health: {
    windowMs: number;
    ipMax: number;
  };
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Public API throttling settings. These are read when route modules are loaded,
 * so changing them requires the same process restart as every other env setting.
 * Invalid explicit values fail startup instead of silently disabling protection.
 */
export function getRateLimitConfig(): RateLimitConfig {
  return {
    auth: {
      windowMs: positiveIntegerEnv("AUTH_RATE_LIMIT_WINDOW_MS", 60_000),
      ipMax: positiveIntegerEnv("AUTH_RATE_LIMIT_IP_MAX", 30),
      challengeAccountMax: positiveIntegerEnv("AUTH_CHALLENGE_RATE_LIMIT_ACCOUNT_MAX", 5),
      verifyAccountMax: positiveIntegerEnv("AUTH_VERIFY_RATE_LIMIT_ACCOUNT_MAX", 10),
    },
    donation: {
      windowMs: positiveIntegerEnv("DONATION_RATE_LIMIT_WINDOW_MS", 60_000),
      ipMax: positiveIntegerEnv("DONATION_RATE_LIMIT_IP_MAX", 60),
      accountMax: positiveIntegerEnv("DONATION_RATE_LIMIT_ACCOUNT_MAX", 20),
    },
    magicLink: {
      windowMs: positiveIntegerEnv("MAGIC_LINK_RATE_LIMIT_WINDOW_MS", 15 * 60_000),
      ipMax: positiveIntegerEnv("MAGIC_LINK_RATE_LIMIT_IP_MAX", 30),
      accountMax: positiveIntegerEnv("MAGIC_LINK_RATE_LIMIT_ACCOUNT_MAX", 5),
    },
    health: {
      windowMs: positiveIntegerEnv("HEALTH_RATE_LIMIT_WINDOW_MS", 60_000),
      ipMax: positiveIntegerEnv("HEALTH_RATE_LIMIT_IP_MAX", 60),
    },
  };
}

export function validateConfig() {
  const missing: string[] = [];

  if (!config.donationContractId) missing.push("DONATION_CONTRACT_ID");
  if (!config.executorSecretKey) missing.push("EXECUTOR_SECRET_KEY");
  if (!config.databaseUrl) missing.push("DATABASE_URL");

  if (missing.length > 0) {
    const msg = `STARTUP CONFIGURATION: Missing required environment variables: ${missing.join(", ")}.`;
    log("warn", msg);
    if (process.env.NODE_ENV === "production") {
      throw new Error(msg);
    }
  }

  // #439: APP_URL, CORS_ALLOWED_ORIGINS and RESEND_API_KEY silently misbehave
  // in production when unset: magic-link and notification emails point at
  // https://localhost:3000, every browser origin is blocked, and sendEmail
  // logs and drops the message while /api/auth/magic-link still says the
  // link was sent. Fail startup in production; warn loudly elsewhere.
  const productionMissing: string[] = [];
  if (!config.appUrl) {
    productionMissing.push("APP_URL (magic-link and notification emails default to https://localhost:3000)");
  }
  if (getAllowedOrigins().length === 0) {
    productionMissing.push("CORS_ALLOWED_ORIGINS (no browser origin is allowed)");
  }
  if (!config.resendApiKey) {
    productionMissing.push("RESEND_API_KEY (emails are logged and dropped, not sent)");
  }

  if (productionMissing.length > 0) {
    const msg = `STARTUP CONFIGURATION: Missing production environment variables: ${productionMissing.join("; ")}.`;
    log("warn", msg);
    if (process.env.NODE_ENV === "production") {
      throw new Error(msg);
    }
  }

  // #439: TRUST_PROXY and STELLAR_NETWORK must parse. A bad value fails
  // startup in production and warns elsewhere instead of silently
  // misbehaving (NaN trust proxy, wrong-chain signing).
  const invalid: string[] = [];
  try {
    getTrustProxy();
  } catch (err) {
    invalid.push((err as Error).message);
  }
  try {
    getStellarNetworkName();
  } catch (err) {
    invalid.push((err as Error).message);
  }

  if (invalid.length > 0) {
    const msg = `STARTUP CONFIGURATION: Invalid environment variables: ${invalid.join("; ")}.`;
    log("warn", msg);
    if (process.env.NODE_ENV === "production") {
      throw new Error(msg);
    }
  }

  // JWT_SECRET is reported by assertRequiredEnv(), which fails closed in every
  // non-test environment. It used to only warn here, and the message claimed an
  // insecure fallback was in use -- that fallback no longer exists (#178), so
  // the warning was actively misleading an operator into thinking the server
  // had started on a known key.
}

/**
 * Random per-process secret used only under NODE_ENV=test. Deliberately
 * generated rather than hardcoded: there is no known signing key anywhere in
 * the source tree, and every token minted/verified in a single test process
 * still agrees because the value is memoized for the process lifetime.
 */
let testOnlyJwtSecret: string | undefined;

function generateTestOnlyJwtSecret(): string {
  if (config.jwtSecret) return config.jwtSecret;
  testOnlyJwtSecret ??= randomBytes(48).toString("hex");
  return testOnlyJwtSecret;
}

export const isTestEnvironment = (): boolean => process.env.NODE_ENV === "test";

export class MissingEnvError extends Error {
  constructor(variable: string) {
    super(
      `${variable} is not set. Refusing to start: a fallback would let anyone ` +
        `forge valid credentials. Set ${variable} in the deployment environment.`
    );
    this.name = "MissingEnvError";
  }
}

/**
 * The signing key for auth tokens. Outside tests this throws rather than
 * falling back to a default, because a publicly-known signing key means any
 * caller can mint a token for any user id (#178).
 */
export function getJwtSecret(): string {
  if (config.jwtSecret) return config.jwtSecret;
  if (isTestEnvironment()) return generateTestOnlyJwtSecret();
  throw new MissingEnvError("JWT_SECRET");
}

/**
 * Startup gate. Called by the server entrypoint before it binds a port so a
 * misconfigured deployment fails immediately and loudly instead of running
 * with a weak or missing secret.
 */
export function assertRequiredEnv(): void {
  getJwtSecret();
}

/**
 * Origins permitted to make credentialed cross-origin API calls.
 *
 * Configured through CORS_ALLOWED_ORIGINS (comma-separated) so a new preview
 * or staging domain is a config change, not a code change (#179). In
 * development the local frontend origins are added as a convenience; in
 * production nothing is assumed, so an unset value means "allow no browser
 * origins" rather than "allow all". Both schemes are added for local dev:
 * `npm run dev` serves the frontend on https://localhost:3000, while
 * `npm run dev:http` and the Playwright web server use plain http.
 */
export function getAllowedOrigins(): string[] {
  const configured = (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);

  const set = new Set(configured);

  if (process.env.NODE_ENV !== "production") {
    for (const devOrigin of [
      "https://localhost:3000",
      "https://127.0.0.1:3000",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ]) {
      set.add(devOrigin);
    }
  }

  return [...set];
}

/**
 * How many reverse-proxy hops Express should trust when working out the real
 * client IP (#439). Accepts the forms Express understands: a hop count
 * ("1" on Railway), a boolean ("true" trusts every proxy, "false" trusts
 * none), or a comma-separated list of trusted IPs / CIDR ranges
 * ("10.0.0.0/8, 192.168.0.0/16").
 *
 * Anything else is a configuration error, not a value to coerce: the old
 * `Number(process.env.TRUST_PROXY)` turned a typo like "abc" into NaN and
 * handed that to Express, silently breaking req.ip and the per-IP rate
 * limits. Unset keeps Express's default.
 */
export type TrustProxySetting = number | boolean | string[];

function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

export function getTrustProxy(): TrustProxySetting | undefined {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw) return undefined;

  const lowered = raw.toLowerCase();
  if (lowered === "true") return true;
  if (lowered === "false") return false;

  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    if (!Number.isSafeInteger(hops)) {
      throw new Error(`TRUST_PROXY must be a number, boolean or CIDR list, got "${raw}"`);
    }
    return hops;
  }

  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error(`TRUST_PROXY must be a number, boolean or CIDR list, got "${raw}"`);
  }

  for (const entry of entries) {
    const [ip, prefix] = entry.split("/");
    if (!isValidIpv4(ip)) {
      throw new Error(
        `TRUST_PROXY entry "${entry}" is not a valid IP or CIDR range: expected an IPv4 address with an optional /prefix`
      );
    }
    if (prefix !== undefined) {
      if (!/^\d+$/.test(prefix) || Number(prefix) < 0 || Number(prefix) > 32) {
        throw new Error(
          `TRUST_PROXY entry "${entry}" has an invalid CIDR prefix: expected 0-32`
        );
      }
    }
  }

  return entries;
}
