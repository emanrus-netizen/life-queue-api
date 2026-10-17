import {
  Router
} from "express";

import {
  requireAuth
} from "../auth/require-auth";

import {
  cancelQueueItemForUser,
  completeQueueItemForUser,
  createQueueItemForUser,
  extendQueueItemTimerForUser,
  getQueueItemForUser,
  importQueueItemsForUser,
  InvalidQueueItemError,
  InvalidQueueItemImportError,
  QueueItemConflictError,
  snoozeQueueItemForUser,
  startQueueItemForUser,
  updateQueueItemForUser,
} from "./queue-item-service";

import { Prisma } from "@prisma/client";
import {
  createQueueItemSchema,
  extendQueueItemSchema,
  importQueueItemsSchema,
  snoozeQueueItemSchema,
  updateQueueItemSchema
} from "./queue-item-schema";

export const queueItemRouter = Router();


/**
 * GET /queue-items
 *
 * Return only QueueItems belonging to the
 * authenticated account.
 */

queueItemRouter.get(
  "/",
  requireAuth,
  async (
    request, response
  ) => {
    try {
      const userId = request.auth!.user.id

      const items = await getQueueItemForUser(userId)

      response.status(200).json({
        items
      });
    } catch (error) {
      console.error('Failed to load QueueItems', error)

      response.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "Unable to load queue items.   "
        }
      })
    }
  }
)



/**
 * POST /queue-items
 *
 * Create a task for the authenticated user.
 */
queueItemRouter.post(
  "/",
  requireAuth,
  async (
    request,
    response,
  ) => {
    const parsed = createQueueItemSchema.safeParse(
      request.body
    );

    if (!parsed.success) {
      response.status(
        400
      ).json({
        error: {
          code: "INVALID_QUEUE_ITEM",
          message: "Queue item data is invalid",
          details: parsed.error.flatten()
        }
      });

      return;
    }

    try {
      const userId = request.auth!.user.id;

      const item = await createQueueItemForUser(userId, parsed.data)

      response.status(201).json({
        item
      })
    } catch (error) {
      if (error instanceof QueueItemConflictError) {
        response.status(409).json({
          error: {
            code: "QUEUE_ITEM_CONFLICT",
            message: error.message,
          }
        });
        return;
      }

      if (error instanceof InvalidQueueItemError) {
        response.status(400).json({
          error: {
            code: "INVALID_QUEUE_ITEM",
            message: error.message,

          }
        });

        return;
      }

      console.error("Failed to create QueueItem.", error);

      response.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "Unable to create queue item."
        }
      });
    }
  }
)


/**
 * PATCH /queue-items/:id
 *
 * Update a task only when the authenticated
 * user owns it.
 */

queueItemRouter.patch(
  "/:id",
  requireAuth,

  async (request, response) => {

    const parsed = updateQueueItemSchema.safeParse(request.body);

    if (!parsed.success) {

      response.status(400).json({
        error: {
          code: "INVALID_QUEUE_ITEM",
          message: "Queue item update is invalid.",
          details: parsed.error.flatten()
        }
      });
      return;
    }

    try {
      const userId = request.auth!.user.id;
      const queueId = request.params.id

      /**
       * A QueueItem route must contain exactly
       * one string ID.
       *
       * We validate instead of using:
       *
       * request.params.id as string
       *
       * because type assertions do not perform
       * runtime validation.
       */

      if (typeof queueId !== "string") {
        response.status(400).json({
          error: {
            code: "INVALID_QUEUE_ITEM_ID",
            message: "Queue item ID is invalid"
          }
        });
        return
      }
      const item = await updateQueueItemForUser(userId, queueId, parsed.data);

      if (!item) {
        /**
        * Same response whether:
        *
        * - ID does not exist
        * - another user owns the ID
        *
        * Avoid leaking resource existence.
        */
        response.status(404).json({
          error: {
            code: "QUEUE_ITEM_NOT_FOUND",
            message: "Queue item was not found.",

          }
        });
        return;
      }

      response.status(200).json({
        item
      })
    } catch (error) {
      console.error(
        "Failed to update QueueItem:",
        error,
      );

      response.status(
        500
      ).json({
        error: {
          code:
            "INTERNAL_ERROR",
          message: "Unable to update queue item."
        }
      })
    }
  }
);

/**
 * POST /queue-items/:id/start
 *
 * Lifecycle command:
 *
 * ACTIVE → IN_PROGRESS
 *
 * This is intentionally separate from PATCH.
 */
queueItemRouter.post(
  "/:id/start",
  requireAuth,

  async (
    request,
    response,
  ) => {
    try {
      const userId =
        request.auth!.user.id;

      const queueId =
        request.params.id;


      if (
        typeof queueId !==
        "string"
      ) {
        response.status(
          400,
        ).json({
          error: {
            code:
              "INVALID_QUEUE_ITEM_ID",

            message:
              "Queue item ID is invalid.",
          },
        });

        return;
      }


      const result =
        await startQueueItemForUser(
          userId,
          queueId,
        );


      if (
        result.kind ===
        "NOT_FOUND"
      ) {
        /**
         * Same 404 whether:
         *
         * - ID does not exist
         * - another user owns it
         */
        response.status(
          404,
        ).json({
          error: {
            code:
              "QUEUE_ITEM_NOT_FOUND",

            message:
              "Queue item was not found.",
          },
        });

        return;
      }


      if (
        result.kind ===
        "INVALID_TRANSITION"
      ) {
        response.status(
          409,
        ).json({
          error: {
            code:
              "INVALID_QUEUE_ITEM_TRANSITION",

            message:
              "Only an active queue item can be started.",

            currentStatus:
              result.currentStatus,
          },
        });

        return;
      }
      if (
        result.kind ===
        "DEFERRED"
      ) {
        response.status(
          409,
        ).json({
          error: {
            code:
              "QUEUE_ITEM_DEFERRED",

            message:
              "This queue item is still snoozed.",

            deferUntil:
              result.deferUntil,
          },
        });

        return;
      }

      response.status(
        200,
      ).json({
        item:
          result.item,
      });

    } catch (error) {
      console.error(
        "Failed to start QueueItem:",
        error,
      );


      response.status(
        500,
      ).json({
        error: {
          code:
            "INTERNAL_ERROR",

          message:
            "Unable to start queue item.",
        },
      });
    }
  },
);

/**
 * POST /queue-items/:id/complete
 *
 * Lifecycle command:
 *
 * IN_PROGRESS → COMPLETED
 */
queueItemRouter.post(
  "/:id/complete",
  requireAuth,

  async (
    request,
    response,
  ) => {
    try {
      const userId =
        request.auth!.user.id;

      const queueId =
        request.params.id;


      if (
        typeof queueId !==
        "string"
      ) {
        response.status(
          400,
        ).json({
          error: {
            code:
              "INVALID_QUEUE_ITEM_ID",

            message:
              "Queue item ID is invalid.",
          },
        });

        return;
      }


      const result =
        await completeQueueItemForUser(
          userId,
          queueId,
        );


      if (
        result.kind ===
        "NOT_FOUND"
      ) {
        /**
         * Same response for:
         *
         * - nonexistent QueueItem
         * - another user's QueueItem
         */
        response.status(
          404,
        ).json({
          error: {
            code:
              "QUEUE_ITEM_NOT_FOUND",

            message:
              "Queue item was not found.",
          },
        });

        return;
      }


      if (
        result.kind ===
        "INVALID_TRANSITION"
      ) {
        response.status(
          409,
        ).json({
          error: {
            code:
              "INVALID_QUEUE_ITEM_TRANSITION",

            message:
              "Only an in-progress queue item can be completed.",

            currentStatus:
              result.currentStatus,
          },
        });

        return;
      }


      response.status(
        200,
      ).json({
        item:
          result.item,
      });

    } catch (error) {
      console.error(
        "Failed to complete QueueItem:",
        error,
      );


      response.status(
        500,
      ).json({
        error: {
          code:
            "INTERNAL_ERROR",

          message:
            "Unable to complete queue item.",
        },
      });
    }
  },
);

/**
 * POST /queue-items/:id/snooze
 *
 * ACTIVE stays ACTIVE.
 *
 * Only deferUntil changes.
 */
queueItemRouter.post(
  "/:id/snooze",
  requireAuth,

  async (
    request,
    response,
  ) => {
    const parsed =
      snoozeQueueItemSchema
        .safeParse(
          request.body,
        );


    if (!parsed.success) {
      response.status(
        400,
      ).json({
        error: {
          code:
            "INVALID_SNOOZE",

          message:
            "Snooze details are invalid.",

          details:
            parsed.error.flatten(),
        },
      });

      return;
    }


    try {
      const userId =
        request.auth!.user.id;

      const queueId =
        request.params.id;


      if (
        typeof queueId !==
        "string"
      ) {
        response.status(
          400,
        ).json({
          error: {
            code:
              "INVALID_QUEUE_ITEM_ID",

            message:
              "Queue item ID is invalid.",
          },
        });

        return;
      }


      const result =
        await snoozeQueueItemForUser(
          userId,
          queueId,
          parsed.data.deferUntil,
        );


      if (
        result.kind ===
        "NOT_FOUND"
      ) {
        response.status(
          404,
        ).json({
          error: {
            code:
              "QUEUE_ITEM_NOT_FOUND",

            message:
              "Queue item was not found.",
          },
        });

        return;
      }


      if (
        result.kind ===
        "INVALID_DEFER_UNTIL"
      ) {
        response.status(
          400,
        ).json({
          error: {
            code:
              "INVALID_SNOOZE_TIME",

            message:
              "Snooze time must be in the future.",
          },
        });

        return;
      }


      if (
        result.kind ===
        "INVALID_TRANSITION"
      ) {
        response.status(
          409,
        ).json({
          error: {
            code:
              "INVALID_QUEUE_ITEM_TRANSITION",

            message:
              "Only an active queue item can be snoozed.",

            currentStatus:
              result.currentStatus,
          },
        });

        return;
      }


      response.status(
        200,
      ).json({
        item:
          result.item,
      });

    } catch (error) {
      console.error(
        "Failed to snooze QueueItem:",
        error,
      );


      response.status(
        500,
      ).json({
        error: {
          code:
            "INTERNAL_ERROR",

          message:
            "Unable to snooze queue item.",
        },
      });
    }
  },
);


/**
 * POST /queue-items/:id/cancel
 *
 * ACTIVE      → CANCELLED
 * IN_PROGRESS → CANCELLED
 */
queueItemRouter.post(
  "/:id/cancel",
  requireAuth,

  async (
    request,
    response,
  ) => {
    try {
      const userId =
        request.auth!.user.id;

      const queueId =
        request.params.id;


      if (
        typeof queueId !==
        "string"
      ) {
        response.status(
          400,
        ).json({
          error: {
            code:
              "INVALID_QUEUE_ITEM_ID",

            message:
              "Queue item ID is invalid.",
          },
        });

        return;
      }


      const result =
        await cancelQueueItemForUser(
          userId,
          queueId,
        );


      if (
        result.kind ===
        "NOT_FOUND"
      ) {
        response.status(
          404,
        ).json({
          error: {
            code:
              "QUEUE_ITEM_NOT_FOUND",

            message:
              "Queue item was not found.",
          },
        });

        return;
      }


      if (
        result.kind ===
        "INVALID_TRANSITION"
      ) {
        response.status(
          409,
        ).json({
          error: {
            code:
              "INVALID_QUEUE_ITEM_TRANSITION",

            message:
              "This queue item cannot be cancelled from its current state.",

            currentStatus:
              result.currentStatus,
          },
        });

        return;
      }


      response.status(
        200,
      ).json({
        item:
          result.item,
      });

    } catch (error) {
      console.error(
        "Failed to cancel QueueItem:",
        error,
      );


      response.status(
        500,
      ).json({
        error: {
          code:
            "INTERNAL_ERROR",

          message:
            "Unable to cancel queue item.",
        },
      });
    }
  },
);


/**
 * POST /queue-items/import
 *
 * Historical migration endpoint.
 *
 * This is deliberately separate from normal
 * QueueItem creation.
 */
queueItemRouter.post(
  "/import",
  requireAuth,

  async (
    request,
    response,
  ) => {
    const parsed =
      importQueueItemsSchema
        .safeParse(
          request.body,
        );


    if (!parsed.success) {
      response.status(
        400,
      ).json({
        error: {
          code:
            "INVALID_QUEUE_IMPORT",

          message:
            "Queue import data is invalid.",

          details:
            parsed.error.flatten(),
        },
      });

      return;
    }


    try {
      const userId =
        request.auth!.user.id;


      const result =
        await importQueueItemsForUser(
          userId,
          parsed.data.items,
        );


      response.status(
        200,
      ).json({
        imported:
          result.imported,

        skippedIds:
          result.skippedIds,
      });

    } catch (error) {
      if (
        error instanceof
        InvalidQueueItemImportError
      ) {
        response.status(
          400,
        ).json({
          error: {
            code:
              "INVALID_QUEUE_IMPORT",

            message:
              error.message,

            queueItemId:
              error.queueItemId,
          },
        });

        return;
      }


      /**
       * A globally duplicated QueueItem ID can
       * still collide with another account
       * because QueueItem.id is the primary key.
       *
       * Never reveal who owns the collision.
       */
      if (
        error instanceof
        Prisma.PrismaClientKnownRequestError &&
        error.code ===
        "P2002"
      ) {
        response.status(
          409,
        ).json({
          error: {
            code:
              "QUEUE_IMPORT_CONFLICT",

            message:
              "One or more queue item IDs cannot be imported.",
          },
        });

        return;
      }


      console.error(
        "Failed to import QueueItems:",
        error,
      );


      response.status(
        500,
      ).json({
        error: {
          code:
            "INTERNAL_ERROR",

          message:
            "Unable to import queue items.",
        },
      });
    }
  },
);

/**
 * POST /queue-items/:id/extend
 *
 * Extend the live timer of an IN_PROGRESS task.
 *
 * This does NOT modify estimatedMinutes.
 *
 * Example:
 *
 * estimatedMinutes = 30
 * timerEndsAt      = 3:00 PM
 *
 * User adds 15 minutes:
 *
 * estimatedMinutes stays 30
 * timerEndsAt becomes 3:15 PM
 */
queueItemRouter.post(
  "/:id/extend",

  requireAuth,

  async (
    request,
    response,
  ) => {
    const parsed =
      extendQueueItemSchema.safeParse(
        request.body,
      );


    if (!parsed.success) {
      response.status(
        400,
      ).json({
        error: {
          code:
            "INVALID_EXTEND_TIME",

          message:
            "Timer extension is invalid.",

          details:
            parsed.error.flatten(),
        },
      });

      return;
    }


    const queueId =
      request.params.id;


    /**
     * Runtime validation matters here.
     *
     * A TypeScript cast would only silence the
     * compiler; it would not validate the actual
     * HTTP request.
     */
    if (
      typeof queueId !==
      "string"
    ) {
      response.status(
        400,
      ).json({
        error: {
          code:
            "INVALID_QUEUE_ITEM_ID",

          message:
            "Queue item ID is invalid.",
        },
      });

      return;
    }


    try {
      /**
       * Identity comes from requireAuth().
       *
       * The client never sends userId.
       */
      const userId =
        request.auth!.user.id;


      const result =
        await extendQueueItemTimerForUser(
          userId,
          queueId,
          parsed.data.additionalMinutes,
        );


      /**
       * Same response whether:
       *
       * - the QueueItem does not exist
       * - another account owns it
       *
       * This avoids leaking resource existence.
       */
      if (
        result.kind ===
        "NOT_FOUND"
      ) {
        response.status(
          404,
        ).json({
          error: {
            code:
              "QUEUE_ITEM_NOT_FOUND",

            message:
              "Queue item was not found.",
          },
        });

        return;
      }


      if (
        result.kind ===
        "INVALID_MINUTES"
      ) {
        response.status(
          400,
        ).json({
          error: {
            code:
              "INVALID_EXTEND_TIME",

            message:
              "Additional minutes must be a positive whole number.",
          },
        });

        return;
      }


      /**
       * Only:
       *
       * IN_PROGRESS → extend timer
       *
       * is allowed.
       */
      if (
        result.kind ===
        "INVALID_TRANSITION"
      ) {
        response.status(
          409,
        ).json({
          error: {
            code:
              "INVALID_QUEUE_ITEM_TRANSITION",

            message:
              "Only an in-progress queue item can have its timer extended.",

            currentStatus:
              result.currentStatus,
          },
        });

        return;
      }


      response.status(
        200,
      ).json({
        item:
          result.item,
      });

    } catch (error) {
      console.error(
        "Failed to extend QueueItem timer:",
        error,
      );


      response.status(
        500,
      ).json({
        error: {
          code:
            "INTERNAL_ERROR",

          message:
            "Unable to extend queue item timer.",
        },
      });
    }
  },
);