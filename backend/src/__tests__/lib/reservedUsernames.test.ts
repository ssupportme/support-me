import fs from "node:fs";
import path from "node:path";
import { createCreatorParamsSchema } from "../../schemas/creators";
import { RESERVED_USERNAMES, isReservedUsername } from "../../lib/reservedUsernames";

describe("reserved usernames (#387)", () => {
  it.each(["admin", "settings", "Admin", "SETTINGS", "support"])(
    "rejects %s in createCreatorParamsSchema",
    (username) => {
      const result = createCreatorParamsSchema.safeParse({ username });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(/reserved/i);
      }
    }
  );

  it("accepts an ordinary username", () => {
    expect(createCreatorParamsSchema.safeParse({ username: "alice" }).success).toBe(true);
  });

  it("still rejects usernames that break the shape", () => {
    expect(createCreatorParamsSchema.safeParse({ username: "a" }).success).toBe(false);
    expect(createCreatorParamsSchema.safeParse({ username: "has space" }).success).toBe(false);
  });

  it("matches reserved names case-insensitively", () => {
    expect(isReservedUsername("SupportMe")).toBe(true);
    expect(isReservedUsername("  Admin  ")).toBe(true);
    expect(isReservedUsername("alice")).toBe(false);
  });

  // Route drift guard: adding a new directory under frontend/app without
  // reserving it must fail CI, otherwise the new route silently shadows a
  // creator profile with the same name.
  it("reserves every top-level route under frontend/app", () => {
    const appDir = path.resolve(__dirname, "../../../../frontend/app");
    const routes = fs
      .readdirSync(appDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      // Private folders (_next, __tests__), dynamic segments ([username]) and
      // route groups ((marketing)) are not claimable names.
      .filter((name) => !name.startsWith("_") && !name.startsWith("[") && !name.startsWith("("));

    expect(routes.length).toBeGreaterThan(0);
    const missing = routes.filter((name) => !RESERVED_USERNAMES.has(name.toLowerCase()));
    expect(missing).toEqual([]);
  });
});
