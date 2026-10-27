/**
 * One-off report for issue #387: list creators whose username is now reserved.
 *
 * Reserved names cannot be created any more, but profiles created before the
 * guard may still hold one. This prints them so the maintainers can decide
 * whether to rename, redirect or grandfather them.
 *
 * Usage: npm run report:reserved-usernames
 */
import prisma from "../prisma";
import { RESERVED_USERNAMES } from "../lib/reservedUsernames";

async function main(): Promise<void> {
  const names = Array.from(RESERVED_USERNAMES);
  const creators = await prisma.creator.findMany({
    where: { username: { in: names, mode: "insensitive" } },
    select: { id: true, username: true, createdAt: true },
    orderBy: { username: "asc" },
  });

  if (creators.length === 0) {
    console.log("No creators hold a reserved username.");
    return;
  }

  console.log(`${creators.length} creator(s) hold a reserved username:`);
  for (const creator of creators) {
    console.log(
      `- ${creator.username} (id ${creator.id}, created ${creator.createdAt.toISOString()})`
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
