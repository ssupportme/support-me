import prisma from "../../prisma";
import { log } from "../../lib/logger";
import { getEmailSendTimeoutMs } from "../../config";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const RESEND_API_URL = "https://api.resend.com/emails";

/**
 * How long a hard bounce or spam complaint suppresses further sends to that
 * address. Not permanent: an address can be fixed (typo corrected, mailbox
 * un-fulled) and Resend re-validates on every send anyway, so this only
 * needs to stop an immediate retry storm, not blocklist forever.
 */
const SUPPRESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * The canonical form of a recipient address: trimmed and lowercased. The
 * local part of an address is case-insensitive for delivery, and Resend
 * echoes back whatever casing it was given, so storing and querying one
 * canonical form is what keeps a bounce recorded as `Bob@x.com` suppressing
 * a later send to `bob@x.com` (#534).
 */
export function normalizeRecipient(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Whether `to` had a bounce or complaint recorded within the suppression
 * window. Checked before every send so a caller retrying on a schedule (e.g.
 * the subscription executor's tick) doesn't keep hammering a dead address.
 *
 * The recipient comparison is case-insensitive as well as normalized, so
 * rows written before normalization existed (or by a path that skipped it)
 * still suppress the address regardless of the casing they were stored with.
 */
async function isSuppressed(to: string): Promise<boolean> {
  const recentBadEvent = await prisma.emailEvent.findFirst({
    where: {
      recipient: { equals: normalizeRecipient(to), mode: "insensitive" },
      type: { in: ["BOUNCED", "COMPLAINED"] },
      createdAt: { gte: new Date(Date.now() - SUPPRESSION_WINDOW_MS) },
    },
    select: { id: true },
  });
  return recentBadEvent !== null;
}

/**
 * AbortSignal.timeout() rejects with a DOMException named TimeoutError;
 * older runtimes and polyfills use AbortError or code ABORT_ERR. All of them
 * mean the same thing here: the provider call hit our deadline (#530).
 */
function isAbortError(err: unknown): boolean {
  // Duck-typed rather than `instanceof Error`: the DOMException raised by
  // AbortSignal.timeout() can come from another realm (jest's sandbox, vm
  // contexts), where instanceof is false even though it is a real abort.
  if (typeof err !== "object" || err === null) return false;
  const { name, code } = err as { name?: unknown; code?: unknown };
  return name === "AbortError" || name === "TimeoutError" || code === "ABORT_ERR";
}

/**
 * Sends a transactional email through Resend's HTTP API when
 * `RESEND_API_KEY` is configured. Without it (local dev, CI), the message is
 * logged instead so the calling flow still runs end to end.
 *
 * Kept to a plain `fetch` so there's no SDK dependency to swap out if the
 * provider changes; only this function knows about Resend. Every attempt
 * (skipped, sent, or failed) is logged and recorded as an EmailEvent so
 * delivery problems are visible without grepping application logs.
 *
 * The provider call is bounded by `EMAIL_SEND_TIMEOUT_MS` (#530): without an
 * AbortSignal a stalled connection never settles, which would hold the
 * awaiting HTTP request (e.g. POST /api/auth/magic-link) open until the
 * platform kills it.
 */
export async function sendEmail(message: EmailMessage): Promise<void> {
  const recipient = normalizeRecipient(message.to);

  if (await isSuppressed(recipient)) {
    log("warn", "email send skipped: recipient suppressed", { to: recipient, subject: message.subject });
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log("info", "email not sent: RESEND_API_KEY unset", { to: recipient, subject: message.subject });
    return;
  }

  const timeoutMs = getEmailSendTimeoutMs();

  let response: Response;
  try {
    response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || "SupportMe <notifications@supportme.app>",
        to: [recipient],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = isAbortError(err);
    const errorDetail = timedOut
      ? `Email provider request timed out after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    log("error", timedOut ? "email send failed: provider timeout" : "email send failed: network error", {
      to: recipient,
      subject: message.subject,
      error: errorDetail,
    });
    await prisma.emailEvent.create({
      data: { recipient, subject: message.subject, type: "FAILED", errorDetail },
    });
    if (timedOut) {
      throw new Error(errorDetail);
    }
    throw err;
  }

  if (!response.ok) {
    const errorDetail = await response.text().catch(() => "");
    log("error", "email send failed: provider error", {
      to: recipient,
      subject: message.subject,
      status: response.status,
      error: errorDetail,
    });
    await prisma.emailEvent.create({
      data: {
        recipient,
        subject: message.subject,
        type: "FAILED",
        errorDetail: `HTTP ${response.status}: ${errorDetail}`,
      },
    });
    throw new Error(`Email provider responded ${response.status}: ${errorDetail}`);
  }

  const body = (await response.json().catch(() => null)) as { id?: string } | null;
  log("info", "email sent", { to: recipient, subject: message.subject, providerMessageId: body?.id });
  await prisma.emailEvent.create({
    data: {
      recipient,
      subject: message.subject,
      type: "SENT",
      providerMessageId: body?.id,
    },
  });
}
