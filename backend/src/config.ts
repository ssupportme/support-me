import { randomBytes } from "crypto";
import { log } from "./lib/logger";

/**
 * Central configuration and validation for environment settings whose absence
 * would silently weaken security.
 *
 * Every getter is lazy (evaluated on call, never at import time) so importing
 * a module that touches config has no side effects and tests can vary the
 * environment per case.
 */

export const config = {
  get donationContractId() { return process.env.NEXT_PUBLIC_DONATION_CONTRACT_ID?.trim() || ""; },
  get executorSecretKey() { return process.env.EXECUTOR_SECRET_KEY?.trim() || ""; },
  get databaseUrl() { return process.env.DATABASE_URL?.trim() || ""; },
  get jwtSecret() { return process.env.JWT_SECRET?.trim() || ""; },
};

export function validateConfig() {
  const missing: string[] = [];

  if (!config.donationContractId) missing.push("NEXT_PUBLIC_DONATION_CONTRACT_ID");
  if (!config.executorSecretKey) missing.push("EXECUTOR_SECRET_KEY");
  if (!config.databaseUrl) missing.push("DATABASE_URL");

  if (missing.length > 0) {
    const msg = `STARTUP CONFIGURATION: Missing required environment variables: ${missing.join(", ")}.`;
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
 * origins" rather than "allow all".
 */
export function getAllowedOrigins(): string[] {
  const configured = (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);

  const set = new Set(configured);

  if (process.env.NODE_ENV !== "production") {
    for (const devOrigin of [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ]) {
      set.add(devOrigin);
    }
  }

  return [...set];
}
