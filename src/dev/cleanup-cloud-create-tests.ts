import "dotenv/config";

import {
    prisma,
} from "../db/prisma.js";


async function run() {
  /**
   * Scope cleanup to this development account.
   *
   * Never perform a broad delete based only on
   * the test prefix.
   */
  const user =
    await prisma.user.findUnique({
      where: {
        email:
          "emanrusiana@gmail.com",
      },

      select: {
        id:
          true,
      },
    });


  if (!user) {
    throw new Error(
      "Development user was not found.",
    );
  }


  const result =
    await prisma.queueItem.deleteMany({
      where: {
        userId:
          user.id,

        id: {
          startsWith:
            "cloud-create-test-",
        },
      },
    });


  console.log(
    `🧹 Deleted ${result.count} cloud-create test QueueItems.`,
  );
}


run()
  .catch(
    error => {
      console.error(
        "Cleanup failed:",
        error,
      );

      process.exitCode =
        1;
    },
  )
  .finally(
    async () => {
      await prisma.$disconnect();
    },
  );