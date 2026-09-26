import { log } from "./lib/logger";

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

  if (!config.jwtSecret) {
    log("warn", "JWT_SECRET is missing, using insecure fallback.");
  }

  if (missing.length > 0) {
    const msg = `STARTUP CONFIGURATION: Missing required environment variables: ${missing.join(", ")}.`;
    log("warn", msg);
    if (process.env.NODE_ENV === "production") {
      throw new Error(msg);
    }
  }
}
