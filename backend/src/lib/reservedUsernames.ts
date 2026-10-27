/**
 * Reserved creator usernames (issue #387).
 *
 * Creator profiles live at `/[username]`, next to static routes. A creator who
 * registers `settings` or `dashboard` gets a profile that can never be reached
 * because the static route wins, and names like `admin` or `support` invite
 * impersonation. The list below is the single source of truth: the create
 * schema rejects these names case-insensitively, and a test walks
 * `frontend/app` so a newly added top-level route fails CI until it is
 * reserved here.
 *
 * Keep every entry lowercase; lookups compare against `toLowerCase()`.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  // Top-level routes under frontend/app (each one shadows a profile).
  "activity",
  "admin",
  "api",
  "app",
  "auth",
  "dashboard",
  "discover",
  "donate",
  "leaderboard",
  "receipt",
  "settings",
  // Sentry tunnel configured in frontend/next.config.ts.
  "monitoring",
  // Platform-sounding names a creator must not be able to claim.
  "about",
  "contact",
  "docs",
  "faq",
  "help",
  "info",
  "login",
  "logout",
  "manifest",
  "moderator",
  "official",
  "privacy",
  "register",
  "robots",
  "root",
  "security",
  "signup",
  "sitemap",
  "staff",
  "status",
  "support",
  "supportme",
  "system",
  "team",
  "terms",
  "_next",
]);

export function isReservedUsername(username: string): boolean {
  return RESERVED_USERNAMES.has(username.trim().toLowerCase());
}
