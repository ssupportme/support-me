import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

/**
 * Security headers for the Next.js app.
 *
 * The CSP is rolled out in Report-Only mode first (Content-Security-Policy-Report-Only)
 * so violations are logged to the browser console without blocking anything.
 * Once no violations appear in normal usage (wallet connect, donate, avatar
 * upload, Sentry), flip ENFORCE_CSP to true to switch to enforcement.
 *
 * Allowed origins:
 *  - Cloudinary (res.cloudinary.com) — avatar/image delivery
 *  - Sentry tunnel (/monitoring) — same-origin rewrite, no external connect needed
 *  - Stellar Horizon (horizon-testnet.stellar.org) — balance/tx lookups
 *  - Stellar RPC (soroban-testnet.stellar.org) — contract simulation/submission
 *  - Stellar Wallet Kit (stellarwalletskit.com) — wallet connect
 *  - Freighter extension (freighter.app) — wallet provider
 *
 * frame-ancestors: 'none' blocks all framing (clickjacking protection).
 * The embeddable widget (docs/design/donation-widget.md) uses an iframe on
 * the /embed route; if that route needs to be framed, add a narrow exception
 * here (e.g. frame-ancestors 'self' https://creator-site.example) rather than
 * opening it to all origins.
 */
const securityHeaders = (enforce: boolean) => {
  const cspHeader = [
    // 'self' covers same-origin scripts, styles, fonts, images, and the Sentry /monitoring tunnel
    "default-src 'self'",
    // Scripts: self + Stellar Wallet Kit + inline (needed for Next.js hydration) + eval (dev only)
    `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""} https://stellarwalletskit.com`,
    // Styles: self + inline (Next.js styled-components / CSS-in-JS)
    "style-src 'self' 'unsafe-inline'",
    // Images: self + Cloudinary (avatar delivery) + data: (inline avatars)
    "img-src 'self' https://res.cloudinary.com data:",
    // Fonts: self
    "font-src 'self'",
    // Connections: self (API + SSE + Sentry tunnel) + Stellar Horizon + Stellar RPC + wallet kit
    "connect-src 'self' https://horizon-testnet.stellar.org https://soroban-testnet.stellar.org https://stellarwalletskit.com https://freighter.app",
    // Frames: none (clickjacking protection; embed widget needs narrow exception)
    "frame-ancestors 'none'",
    // Forms: self only
    "form-action 'self'",
    // Base: self only (prevents base-hijacking)
    "base-uri 'self'",
    // Object/plugins: none
    "object-src 'none'",
    // Media: self
    "media-src 'self'",
    // Worker: self
    "worker-src 'self'",
  ].join("; ");

  const headers = [
    {
      key: enforce ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only",
      value: cspHeader,
    },
    {
      key: "X-Content-Type-Options",
      value: "nosniff",
    },
    {
      key: "Referrer-Policy",
      value: "strict-origin-when-cross-origin",
    },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
    },
    {
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains; preload",
    },
    {
      // Redundant with CSP frame-ancestors for older browsers
      key: "X-Frame-Options",
      value: "DENY",
    },
  ];

  return headers;
};

// Flip to true to enforce the CSP once no report-only violations appear.
const ENFORCE_CSP = process.env.ENFORCE_CSP === "true";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'res.cloudinary.com',
      },
    ],
  },
  async headers() {
    return [
      {
        // Apply security headers to all routes
        source: "/:path*",
        headers: securityHeaders(ENFORCE_CSP),
      },
    ];
  },
};

const sentryConfigured = Boolean(
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
);

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: process.env.SENTRY_ORG,

  project: process.env.SENTRY_PROJECT,

  authToken: process.env.SENTRY_AUTH_TOKEN,

  sourcemaps: { disable: !sentryConfigured },

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: sentryConfigured,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: sentryConfigured ? "/monitoring" : undefined,

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
