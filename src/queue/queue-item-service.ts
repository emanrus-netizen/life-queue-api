import {
  Prisma
} from "@prisma/client";

import {
  prisma
} from "../db/prisma";

import { HistoricalQueueItem, validateHistoricalQueueItem } from "./queue-import-validation";
import type {
  CreateQueueItemInput,
  UpdateQueueItemInput,
} from "./queue-item-schema";

type QueueDbClient =
  Prisma.TransactionClient |
  typeof prisma;

/**
 * Read ONLY tasks belonging to the verified
 * authenticated user.
 *
 * There is intentionally no version of this
 * service that simply says:
 *
 * db.queueItem.findMany()
 *
 * because user ownership should be difficult
 * to accidentally forget.
 */

export async function getQueueItemForUser(
  userId: string,
  db: QueueDbClient =
    prisma,
) {
  return db.queueItem.findMany({
    where: {
      userId,
    },
    orderBy: {
      createdAt: "asc"
    }
  })
}


/**
 * Create a QueueItem owned by the currently
 * authenticated account.
 *
 * SECURITY:
 *
 * input has no userId.
 *
 * The userId argument comes from requireAuth().
 */
export async function createQueueItemForUser(
  userId: string,
  input: CreateQueueItemInput,
  db: QueueDbClient =
    prisma,
) {
  /*
  * The frontend is allowed to preserve an
  * offline creation timestamp, but we should
  * reject timestamps absurdly far into the
  * future.
  *
  * Five minutes allows ordinary device clock
  * differences without allowing arbitrary
  * future creation dates.
  */

  const createdAt = new Date(input.createdAt);

  const maximumCreatedAt = Date.now() + 5 * 60 * 1000

  if (createdAt.getTime() > maximumCreatedAt) {
    throw new InvalidQueueItemError(
      "createdAt cannot be in the future.",
    );
  }

  try {
    return await db.queueItem.create({
      data: {
        id:
          input.id,

        userId,

        title:
          input.title,

        description:
          input.description,

        /**
         * New QueueItems always begin ACTIVE.
         *
         * The client does not get to choose lifecycle
         * state during ordinary creation.
         */
        status:
          "ACTIVE",

        priority:
          input.priority,

        estimatedMinutes:
          input.estimatedMinutes,

        dueAt:
          toOptionalDate(
            input.dueAt,
          ),

        context:
          input.context,

        energy:
          input.energy,

        deferUntil:
          null,

        startedAt:
          null,

        timerEndsAt:
          null,

        completedAt:
          null,

        createdAt,
      }
    });
  } catch (error) {
    /**
* A client-generated ID might already
* exist.
*
* Do not expose who owns that existing ID.
*/
    if (
      error instanceof
      Prisma.PrismaClientKnownRequestError &&
      error.code ===
      "P2002"
    ) {
      throw new QueueItemConflictError();
    }


    throw error;
  }
};


/**
 * Update ONLY a QueueItem that belongs to the
 * authenticated user.
 *
 * We use updateMany rather than update({ id })
 * so ownership participates in the actual
 * database mutation:
 *
 * WHERE id = ?
 * AND userId = authenticatedUserId
 */

export async function updateQueueItemForUser(
  userId: string,
  queueItemId: string,
  input: UpdateQueueItemInput,
  db: QueueDbClient =
    prisma,) {
  const result = await db.queueItem.updateMany({
    where: {
      userId,
      id: queueItemId
    },
    data: {
      title:
        input.title,

      description:
        input.description,

      priority:
        input.priority,

      dueAt:
        toOptionalDate(
          input.dueAt,
        ),

      context:
        input.context,

      energy:
        input.energy,
    }
  });


  /**
   * Important security behavior:
   *
   * These cases both become NOT FOUND:
   *
   * - task does not exist
   * - task belongs to another user
   *
   * We don't tell an attacker:
   *
   * "That ID exists, but belongs to somebody."
   */
  if (
    result.count === 0
  ) {
    return null;
  }


  return db.queueItem.findFirst({
    where: {
      id:
        queueItemId,

      userId,
    },
  });
}


/**
 * Convert JSON boundary values into values
 * Prisma understands.
 *
 * undefined:
 *   caller did not provide the field
 *   → don't modify it
 *
 * null:
 *   caller deliberately clears the field
 *
 * string:
 *   convert ISO timestamp to Date
 */
function toOptionalDate(
  value:
    string |
    null |
    undefined,
) {
  if (
    value ===
    undefined
  ) {
    return undefined;
  }


  if (
    value ===
    null
  ) {
    return null;
  }


  return new Date(
    value,
  );
}



/**
 * Expected domain-level API errors.
 *
 * This keeps things like ID collisions and
 * invalid creation timestamps separate from
 * unexpected database/server failures.
 */

export class QueueItemConflictError extends Error {
  constructor() {
    super(
      "Queue item ID already exists.",
    );
    this.name = "QueueItemConflictError"
  }
}

export class InvalidQueueItemError extends Error {
  constructor(message: string,) {
    super(message);

    this.name = "InvalidQueueItemError";
  }
}


/**
 * Start a QueueItem owned by the authenticated user.
 *
 * Only ACTIVE tasks may transition to IN_PROGRESS.
 *
 * SECURITY:
 *
 * Ownership and lifecycle state both participate
 * in the database mutation:
 *
 * WHERE
 *   id = ?
 *   AND userId = authenticatedUserId
 *   AND status = ACTIVE
 *
 * This helps prevent race conditions where two
 * requests try to start the same task at once.
 */
export async function startQueueItemForUser(
  userId: string,
  queueItemId: string,

  db: QueueDbClient =
    prisma,

  effectiveAt:
    Date = new Date(),
) {
  const startedAt =
    effectiveAt;


  /**
   * We first need the owned task so we can:
   *
   * - know whether it exists for this user
   * - read estimatedMinutes
   * - calculate timerEndsAt
   *
   * We never query by ID alone here.
   */
  const existingItem =
    await db.queueItem.findFirst({
      where: {
        id:
          queueItemId,

        userId,
      },

      select: {
        id:
          true,

        status:
          true,

        estimatedMinutes:
          true,

        deferUntil:
          true
      },
    });


  if (!existingItem) {
    return {
      kind:
        "NOT_FOUND" as const,
    };
  }


  if (
    existingItem.status !==
    "ACTIVE"
  ) {
    return {
      kind:
        "INVALID_TRANSITION" as const,

      currentStatus:
        existingItem.status,
    };
  }

  /**
 * ACTIVE does not automatically mean eligible.
 *
 * A snoozed task is still ACTIVE, but cannot be
 * started until its deferUntil boundary passes.
 */
  if (
    existingItem.deferUntil &&
    existingItem.deferUntil.getTime() >
    startedAt.getTime()
  ) {
    return {
      kind:
        "DEFERRED" as const,

      deferUntil:
        existingItem.deferUntil,
    };
  }

  /**
   * The original estimate remains unchanged.
   *
   * timerEndsAt is derived from the moment the
   * task actually starts.
   */
  const timerEndsAt =
    existingItem.estimatedMinutes
      ? new Date(
        startedAt.getTime() +
        existingItem.estimatedMinutes *
        60_000,
      )
      : null;


  /**
   * We still include status = ACTIVE here.
   *
   * Why?
   *
   * Between our read above and this update,
   * another request could have started the task.
   *
   * This makes the database enforce the final
   * transition atomically.
   */
  const result =
    await db.queueItem.updateMany({
      where: {
        id:
          queueItemId,

        userId,

        status:
          "ACTIVE",

        OR: [
          {
            deferUntil:
              null,
          },
          {
            deferUntil: {
              lte:
                startedAt,
            },
          },
        ],
      },

      data: {
        status:
          "IN_PROGRESS",

        startedAt,

        timerEndsAt,

        /**
         * The snooze has expired and the task is now
         * actually starting, so clear the old boundary.
         */
        deferUntil:
          null,

        completedAt:
          null,
      },
    });

  /**
   * If another request won the race after our
   * first read, this update affects zero rows.
   */
  if (
    result.count === 0
  ) {
    const currentItem =
      await db.queueItem.findFirst({
        where: {
          id:
            queueItemId,

          userId,
        },

        select: {
          status:
            true,

          deferUntil:
            true,
        },
      });


    if (!currentItem) {
      return {
        kind:
          "NOT_FOUND" as const,
      };
    }


    if (
      currentItem.status ===
      "ACTIVE" &&
      currentItem.deferUntil &&
      currentItem.deferUntil.getTime() >
      startedAt.getTime()
    ) {
      return {
        kind:
          "DEFERRED" as const,

        deferUntil:
          currentItem.deferUntil,
      };
    }


    return {
      kind:
        "INVALID_TRANSITION" as const,

      currentStatus:
        currentItem.status,
    };
  }


  const item =
    await db.queueItem.findFirst({
      where: {
        id:
          queueItemId,

        userId,
      },
    });


  if (!item) {
    /**
     * Extremely defensive fallback.
     *
     * The item existed and was just updated,
     * so normally this cannot occur.
     */
    return {
      kind:
        "NOT_FOUND" as const,
    };
  }


  return {
    kind:
      "STARTED" as const,

    item,
  };
}

/**
 * Complete an IN_PROGRESS QueueItem.
 *
 * Lifecycle:
 *
 * IN_PROGRESS → COMPLETED
 *
 * We do NOT require the timer to have expired.
 * A user may finish earlier than estimated.
 *
 * completedAt records when the work actually
 * finished.
 *
 * timerEndsAt is cleared because there is no
 * longer an active timer.
 */
export async function completeQueueItemForUser(
  userId: string,
  queueItemId: string,

  db: QueueDbClient =
    prisma,

  effectiveAt:
    Date = new Date(),
) {
  const completedAt =
    effectiveAt;


  /**
   * Always include ownership when looking up
   * QueueItems.
   *
   * Never query by ID alone and then decide
   * afterward whether the caller owns it.
   */
  const existingItem =
    await db.queueItem.findFirst({
      where: {
        id:
          queueItemId,

        userId,
      },

      select: {
        status:
          true,

        startedAt:
          true,
      },
    });


  if (!existingItem) {
    return {
      kind:
        "NOT_FOUND" as const,
    };
  }


  /**
   * Completion is only valid for work that was
   * actually started.
   */
  if (
    existingItem.status !==
    "IN_PROGRESS" ||
    !existingItem.startedAt
  ) {
    return {
      kind:
        "INVALID_TRANSITION" as const,

      currentStatus:
        existingItem.status,
    };
  }


  /**
   * Ownership AND expected lifecycle state are
   * part of the mutation itself.
   *
   * This protects us from races such as two
   * completion requests arriving almost at the
   * same time.
   */
  const result =
    await db.queueItem.updateMany({
      where: {
        id:
          queueItemId,

        userId,

        status:
          "IN_PROGRESS",
      },

      data: {
        status:
          "COMPLETED",

        completedAt,

        /**
         * No active work means no active timer.
         *
         * Historical planned duration is still
         * available from:
         *
         * startedAt + estimatedMinutes
         */
        timerEndsAt:
          null,
      },
    });


  if (
    result.count === 0
  ) {
    /**
     * Something changed between our first read
     * and the mutation.
     *
     * Re-read through the ownership boundary so
     * we can safely determine the current state.
     */
    const currentItem =
      await db.queueItem.findFirst({
        where: {
          id:
            queueItemId,

          userId,
        },

        select: {
          status:
            true,
        },
      });


    if (!currentItem) {
      return {
        kind:
          "NOT_FOUND" as const,
      };
    }


    return {
      kind:
        "INVALID_TRANSITION" as const,

      currentStatus:
        currentItem.status,
    };
  }


  const item =
    await db.queueItem.findFirst({
      where: {
        id:
          queueItemId,

        userId,
      },
    });


  if (!item) {
    return {
      kind:
        "NOT_FOUND" as const,
    };
  }


  return {
    kind:
      "COMPLETED" as const,

    item,
  };
}


/**
 * Snooze an ACTIVE QueueItem.
 *
 * Snoozing does NOT introduce a SNOOZED status.
 *
 * Instead:
 *
 * status     = ACTIVE
 * deferUntil = future timestamp
 *
 * This means the task still exists in the active
 * queue, but is temporarily ineligible for
 * recommendation/start.
 */
export async function snoozeQueueItemForUser(
  userId: string,
  queueItemId: string,
  deferUntilValue: string,

  db: QueueDbClient =
    prisma,

  effectiveAt:
    Date = new Date(),
) {
  const now =
    effectiveAt;

  const deferUntil =
    new Date(
      deferUntilValue,
    );


  /**
   * A snooze boundary must actually be in the
   * future.
   *
   * Otherwise a request such as:
   *
   * deferUntil = yesterday
   *
   * has no useful snooze meaning.
   */
  if (
    deferUntil.getTime() <=
    now.getTime()
  ) {
    return {
      kind:
        "INVALID_DEFER_UNTIL" as const,
    };
  }


  const existingItem =
    await db.queueItem.findFirst({
      where: {
        id:
          queueItemId,

        userId,
      },

      select: {
        status:
          true,
      },
    });


  if (!existingItem) {
    return {
      kind:
        "NOT_FOUND" as const,
    };
  }


  /**
   * For now, only an ACTIVE task can be snoozed.
   *
   * We do not allow:
   *
   * IN_PROGRESS
   * COMPLETED
   * CANCELLED
   */
  if (
    existingItem.status !==
    "ACTIVE"
  ) {
    return {
      kind:
        "INVALID_TRANSITION" as const,

      currentStatus:
        existingItem.status,
    };
  }


  /**
   * Include ACTIVE in the actual database
   * mutation.
   *
   * If another request starts the task between
   * our read and update, this update affects
   * zero rows instead of snoozing an
   * IN_PROGRESS task.
   */
  const result =
    await db.queueItem.updateMany({
      where: {
        id:
          queueItemId,

        userId,

        status:
          "ACTIVE",
      },

      data: {
        deferUntil,
      },
    });


  if (
    result.count === 0
  ) {
    const currentItem =
      await db.queueItem.findFirst({
        where: {
          id:
            queueItemId,

          userId,
        },

        select: {
          status:
            true,
        },
      });


    if (!currentItem) {
      return {
        kind:
          "NOT_FOUND" as const,
      };
    }


    return {
      kind:
        "INVALID_TRANSITION" as const,

      currentStatus:
        currentItem.status,
    };
  }


  const item =
    await db.queueItem.findFirst({
      where: {
        id:
          queueItemId,

        userId,
      },
    });


  if (!item) {
    return {
      kind:
        "NOT_FOUND" as const,
    };
  }


  return {
    kind:
      "SNOOZED" as const,

    item,
  };
}

/**
 * Permanently cancel a QueueItem.
 *
 * Allowed:
 *
 * ACTIVE      → CANCELLED
 * IN_PROGRESS → CANCELLED
 *
 * Terminal:
 *
 * COMPLETED   → reject
 * CANCELLED   → reject
 *
 * CANCEL is different from SKIP.
 *
 * Skip means:
 * "Do not recommend this right now."
 *
 * Cancel means:
 * "I no longer intend to complete this task."
 */
export async function cancelQueueItemForUser(
  userId: string,
  queueItemId: string,
  db: QueueDbClient =
    prisma,
) {
  const existingItem =
    await db.queueItem.findFirst({
      where: {
        id:
          queueItemId,

        userId,
      },

      select: {
        status:
          true,
      },
    });


  if (!existingItem) {
    return {
      kind:
        "NOT_FOUND" as const,
    };
  }


  if (
    existingItem.status ===
    "COMPLETED" ||
    existingItem.status ===
    "CANCELLED"
  ) {
    return {
      kind:
        "INVALID_TRANSITION" as const,

      currentStatus:
        existingItem.status,
    };
  }


  /**
   * Ownership and allowed states participate in
   * the database mutation itself.
   *
   * This protects us if another request completes
   * or cancels the task after our first read.
   */
  const result =
    await db.queueItem.updateMany({
      where: {
        id:
          queueItemId,

        userId,

        status: {
          in: [
            "ACTIVE",
            "IN_PROGRESS",
          ],
        },
      },

      data: {
        status:
          "CANCELLED",

        /**
         * A cancelled task should no longer have
         * an active snooze boundary.
         */
        deferUntil:
          null,

        /**
         * A cancelled task should not keep an
         * active countdown running.
         */
        timerEndsAt:
          null,

        /**
         * CANCELLED is not COMPLETED.
         */
        completedAt:
          null,
      },
    });


  if (
    result.count === 0
  ) {
    const currentItem =
      await db.queueItem.findFirst({
        where: {
          id:
            queueItemId,

          userId,
        },

        select: {
          status:
            true,
        },
      });


    if (!currentItem) {
      return {
        kind:
          "NOT_FOUND" as const,
      };
    }


    return {
      kind:
        "INVALID_TRANSITION" as const,

      currentStatus:
        currentItem.status,
    };
  }


  const item =
    await db.queueItem.findFirst({
      where: {
        id:
          queueItemId,

        userId,
      },
    });


  if (!item) {
    return {
      kind:
        "NOT_FOUND" as const,
    };
  }


  return {
    kind:
      "CANCELLED" as const,

    item,
  };
};

/**
 * Import QueueItems that already existed on the
 * authenticated user's device before cloud sync.
 *
 * IMPORTANT:
 *
 * This is migration logic, not normal task
 * creation.
 *
 * Existing cloud rows are NEVER overwritten.
 */
export async function importQueueItemsForUser(
  userId: string,
  items: HistoricalQueueItem[],
) {
  /**
   * Validate the complete batch BEFORE writing
   * anything.
   *
   * We do not want:
   *
   * item 1 imported ✅
   * item 2 invalid ❌
   * item 3 never processed
   *
   * leaving a mysterious partial migration.
   */
  for (
    const item of
    items
  ) {
    const validationError =
      validateHistoricalQueueItem(
        item,
      );


    if (validationError) {
      throw new InvalidQueueItemImportError(
        item.id,
        validationError,
      );
    }
  }


  /**
   * Look up IDs that THIS authenticated user
   * already owns.
   *
   * These will simply be skipped, making a
   * repeated migration request idempotent for
   * the user's existing rows.
   */
  const existingItems =
    await prisma.queueItem.findMany({
      where: {
        userId,

        id: {
          in:
            items.map(
              item =>
                item.id,
            ),
        },
      },

      select: {
        id:
          true,
      },
    });


  const existingIds =
    new Set(
      existingItems.map(
        item =>
          item.id,
      ),
    );


  const itemsToImport =
    items.filter(
      item =>
        !existingIds.has(
          item.id,
        ),
    );


  /**
   * Use a transaction so the import is
   * all-or-nothing.
   */
  const imported =
    await prisma.$transaction(
      async transaction => {
        const importedItems =
          [];


        for (
          const item of
          itemsToImport
        ) {
          const created =
            await transaction.queueItem.create({
              data: {
                id:
                  item.id,

                /**
                 * Ownership comes ONLY from
                 * requireAuth → userId.
                 */
                userId,

                title:
                  item.title,

                description:
                  item.description,

                status:
                  item.status,

                priority:
                  item.priority,

                estimatedMinutes:
                  item.estimatedMinutes ??
                  null,

                dueAt:
                  item.dueAt
                    ? new Date(
                      item.dueAt,
                    )
                    : null,

                deferUntil:
                  item.deferUntil
                    ? new Date(
                      item.deferUntil,
                    )
                    : null,

                context:
                  item.context,

                energy:
                  item.energy ??
                  null,

                startedAt:
                  item.startedAt
                    ? new Date(
                      item.startedAt,
                    )
                    : null,

                /**
                 * Preserve historical timer
                 * information exactly as it existed
                 * locally during migration.
                 */
                timerEndsAt:
                  item.timerEndsAt
                    ? new Date(
                      item.timerEndsAt,
                    )
                    : null,

                completedAt:
                  item.completedAt
                    ? new Date(
                      item.completedAt,
                    )
                    : null,

                createdAt:
                  new Date(
                    item.createdAt,
                  ),
              },
            });


          importedItems.push(
            created,
          );
        }


        return importedItems;
      },
    );


  return {
    imported,

    skippedIds:
      Array.from(
        existingIds,
      ),
  };
}


export class InvalidQueueItemImportError
  extends Error {
  queueItemId:
    string;


  constructor(
    queueItemId:
      string,

    message:
      string,
  ) {
    super(
      message,
    );

    this.name =
      "InvalidQueueItemImportError";

    this.queueItemId =
      queueItemId;
  }
}

/**
 * Extend an IN_PROGRESS QueueItem timer.
 *
 * We do NOT change estimatedMinutes.
 *
 * estimatedMinutes = original estimate
 * timerEndsAt      = live timer deadline
 *
 * If the timer has already expired, extension
 * begins from "now".
 *
 * If it still has time left, extension begins
 * from the existing timerEndsAt.
 */
export async function extendQueueItemTimerForUser(
  userId: string,
  queueItemId: string,
  additionalMinutes: number,

  db: QueueDbClient =
    prisma,

  effectiveAt:
    Date = new Date(),
) {
  // ...

  /**
   * Defense in depth.
   *
   * The route should validate this too, but
   * service code should not assume every caller
   * is an HTTP route.
   */
  if (
    !Number.isInteger(
      additionalMinutes,
    ) ||
    additionalMinutes <= 0
  ) {
    return {
      kind:
        "INVALID_MINUTES" as const,
    };
  }



  const now =
    effectiveAt;

  /**
   * SECURITY:
   *
   * Ownership is part of the lookup.
   *
   * We never fetch:
   *
   * WHERE id = queueItemId
   *
   * and then check ownership afterward.
   */
  const existingItem =
    await db.queueItem.findFirst({
      where: {
        id:
          queueItemId,

        userId,
      },

      select: {
        status:
          true,

        timerEndsAt:
          true,
      },
    });


  if (!existingItem) {
    return {
      kind:
        "NOT_FOUND" as const,
    };
  }


  /**
   * Only work that is currently in progress
   * may receive more timer time.
   */
  if (
    existingItem.status !==
    "IN_PROGRESS"
  ) {
    return {
      kind:
        "INVALID_TRANSITION" as const,

      currentStatus:
        existingItem.status,
    };
  }


  /**
   * If time remains:
   *
   * 3:00 deadline
   * +15 min
   * → 3:15
   *
   * If deadline already expired:
   *
   * now = 3:10
   * old deadline = 3:00
   * +15 min
   * → 3:25
   *
   * This matches the behavior your local domain
   * was already using.
   */
  const extensionBase =
    existingItem.timerEndsAt &&
      existingItem.timerEndsAt.getTime() >
      now.getTime()
      ? existingItem.timerEndsAt
      : now;


  const timerEndsAt =
    new Date(
      extensionBase.getTime() +
      additionalMinutes *
      60_000,
    );


  /**
   * Ownership AND expected lifecycle state are
   * part of the mutation itself.
   *
   * If another request completes/cancels this
   * task between our read and update, we do not
   * overwrite that newer state.
   */
  const result =
    await db.queueItem.updateMany({
      where: {
        id:
          queueItemId,

        userId,

        status:
          "IN_PROGRESS",
      },

      data: {
        timerEndsAt,
      },
    });


  if (
    result.count === 0
  ) {
    const currentItem =
      await db.queueItem.findFirst({
        where: {
          id:
            queueItemId,

          userId,
        },

        select: {
          status:
            true,
        },
      });


    if (!currentItem) {
      return {
        kind:
          "NOT_FOUND" as const,
      };
    }


    return {
      kind:
        "INVALID_TRANSITION" as const,

      currentStatus:
        currentItem.status,
    };
  }


  const item =
    await db.queueItem.findFirst({
      where: {
        id:
          queueItemId,

        userId,
      },
    });


  if (!item) {
    return {
      kind:
        "NOT_FOUND" as const,
    };
  }


  return {
    kind:
      "EXTENDED" as const,

    item,
  };
}

