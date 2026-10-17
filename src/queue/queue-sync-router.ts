import {
    Router,
} from "express";

import {
    requireAuth,
} from "../auth/require-auth";

import {
    applyQueueSyncOperation,
    QueueSyncError,
} from "./queue-sync-service";

import {
    queueSyncOperationSchema,
} from "./queue-sync-schema";


export const queueSyncRouter =
  Router();


/**
 * POST /queue-sync
 *
 * Apply one persisted client mutation.
 *
 * SECURITY:
 *
 * userId NEVER comes from request.body.
 *
 * It always comes from:
 *
 * Bearer token
 *      ↓
 * requireAuth
 *      ↓
 * request.auth.user.id
 */
queueSyncRouter.post(
  "/",
  requireAuth,

  async (
    request,
    response,
  ) => {
    const parsed =
      queueSyncOperationSchema
        .safeParse(
          request.body,
        );


    if (
      !parsed.success
    ) {
      response
        .status(
          400,
        )
        .json({
          error: {
            code:
              "INVALID_QUEUE_SYNC_OPERATION",

            message:
              "Queue sync operation is invalid.",

            details:
              parsed.error.flatten(),
          },
        });


      return;
    }


    try {
      const userId =
        request.auth!
          .user.id;


      const result =
        await applyQueueSyncOperation(
          userId,
          parsed.data,
        );


      response
        .status(
          200,
        )
        .json({
          operationId:
            result.operationId,

          alreadyApplied:
            result.alreadyApplied,

          item:
            result.item,
        });

    } catch (error) {
      if (
        error instanceof
        QueueSyncError
      ) {
        response
          .status(
            error.statusCode,
          )
          .json({
            error: {
              code:
                error.code,

              message:
                error.message,
            },
          });


        return;
      }


      console.error(
        "Failed to apply Queue sync operation:",
        error,
      );


      response
        .status(
          500,
        )
        .json({
          error: {
            code:
              "INTERNAL_ERROR",

            message:
              "Unable to sync queue operation.",
          },
        });
    }
  },
);