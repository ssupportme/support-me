import { callSorobanRpc } from "./sorobanRpc";

const RPC_TIMEOUT_MS = 1500;
// Keep enough total budget for one timed-out endpoint to fail over to the
// next one; the health route still returns promptly with a degraded status.
const RPC_TOTAL_TIMEOUT_MS = RPC_TIMEOUT_MS * 2;

export async function checkSorobanRpc(): Promise<{ status: "ok" | "down"; latencyMs?: number }> {
  const startedAt = Date.now();

  try {
    const result = await callSorobanRpc<{ sequence: number }>(
      "getLatestLedger",
      {},
      {
        timeoutMs: RPC_TIMEOUT_MS,
        totalTimeoutMs: RPC_TOTAL_TIMEOUT_MS,
        // A health probe answers "is the RPC reachable right now". Retrying
        // would only make /health slower without making the app healthier,
        // and would exceed the 3s budget above.
        retries: 0,
      }
    );
    if (typeof result.sequence !== "number") return { status: "down" };
    return { status: "ok", latencyMs: Date.now() - startedAt };
  } catch {
    return { status: "down" };
  }
}
