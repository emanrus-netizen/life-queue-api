import {
    createHash,
} from "node:crypto";

import {
    Prisma,
} from "@prisma/client";

import {
    prisma,
} from "../db/prisma";

import {
    cancelQueueItemForUser,
    completeQueueItemForUser,
    createQueueItemForUser,
    extendQueueItemTimerForUser,
    InvalidQueueItemError,
    QueueItemConflictError,
    snoozeQueueItemForUser,
    startQueueItemForUser,
    updateQueueItemForUser,
} from "./queue-item-service";

import type {
    QueueSyncOperationInput,
} from "./queue-sync-schema";


/**
 * Expected Queue sync failure.
 *
 * Routes can safely expose these errors to
 * the client without leaking database details.
 */
export class QueueSyncError
  extends Error {
  statusCode:
    number;

  code:
    string;


  constructor(
    statusCode: number,
    code: string,
    message: string,
  ) {
    super(
      message,
    );

    this.name =
      "QueueSyncError";

    this.statusCode =
      statusCode;

    this.code =
      code;
  }
}


/**
 * Stable JSON serialization.
 *
 * Normal JSON.stringify() preserves insertion
 * order, so two semantically identical objects
 * with differently ordered keys could otherwise
 * produce different hashes.
 *
 * Sorting keys removes that ambiguity.
 */
function stableStringify(
  value: unknown,
): string {
  if (
    value === null
  ) {
    return "null";
  }


  if (
    value === undefined
  ) {
    return "null";
  }


  if (
    typeof value !==
    "object"
  ) {
    return JSON.stringify(
      value,
    );
  }


  if (
    Array.isArray(
      value,
    )
  ) {
    return `[${value
      .map(
        stableStringify,
      )
      .join(",")}]`;
  }


  const record =
    value as
      Record<
        string,
        unknown
      >;


  const keys =
    Object.keys(
      record,
    )
      .filter(
        key =>
          record[key] !==
          undefined,
      )
      .sort();


  const parts =
    keys.map(
      key =>
        `${JSON.stringify(
          key,
        )}:${stableStringify(
          record[key],
        )}`,
    );


  return `{${parts.join(
    ",",
  )}}`;
}


/**
 * Fingerprint the logical mutation.
 *
 * operationId itself is intentionally NOT
 * part of this hash.
 *
 * We want to answer:
 *
 * "Did this operationId previously represent
 * exactly this mutation?"
 */
function createRequestHash(
  operation:
    QueueSyncOperationInput,
) {
  const canonicalRequest = {
    entityId:
      operation.entityId,

    type:
      operation.type,

    occurredAt:
      operation.occurredAt,

    payload:
      operation.payload,
  };


  return createHash(
    "sha256",
  )
    .update(
      stableStringify(
        canonicalRequest,
      ),
    )
    .digest(
      "hex",
    );
}


/**
 * Prevent a device clock from creating lifecycle
 * timestamps far in the future.
 *
 * Five minutes gives ordinary clock drift some
 * tolerance.
 */
function validateOccurredAt(
  occurredAt: Date,
) {
  const maximumAllowed =
    Date.now() +
    5 * 60 * 1000;


  if (
    occurredAt.getTime() >
    maximumAllowed
  ) {
    throw new QueueSyncError(
      400,
      "INVALID_SYNC_TIME",
      "Queue sync operation time is too far in the future.",
    );
  }
}


async function getOwnedQueueItem(
  userId: string,
  entityId: string,

  db:
    Prisma.TransactionClient |
    typeof prisma,
) {
  return db.queueItem.findFirst({
    where: {
      id:
        entityId,

      userId,
    },
  });
}


/**
 * Execute ONE mutation using the SAME transaction
 * that owns the sync receipt.
 */
async function executeOperation(
  userId: string,

  operation:
    QueueSyncOperationInput,

  tx:
    Prisma.TransactionClient,
) {
  const occurredAt =
    new Date(
      operation.occurredAt,
    );


  switch (
    operation.type
  ) {
    case "CREATE": {
      /**
       * entityId and payload.id describe the same
       * QueueItem and must never disagree.
       */
      if (
        operation.payload.id !==
        operation.entityId
      ) {
        throw new QueueSyncError(
          400,
          "SYNC_ENTITY_ID_MISMATCH",
          "Queue sync entity ID does not match the create payload.",
        );
      }


      try {
        return await createQueueItemForUser(
          userId,
          operation.payload,
          tx,
        );

      } catch (error) {
        if (
          error instanceof
          QueueItemConflictError
        ) {
          throw new QueueSyncError(
            409,
            "QUEUE_ITEM_CONFLICT",
            error.message,
          );
        }


        if (
          error instanceof
          InvalidQueueItemError
        ) {
          throw new QueueSyncError(
            400,
            "INVALID_QUEUE_ITEM",
            error.message,
          );
        }


        throw error;
      }
    }


    case "UPDATE": {
      const item =
        await updateQueueItemForUser(
          userId,
          operation.entityId,
          operation.payload,
          tx,
        );


      if (!item) {
        throw new QueueSyncError(
          404,
          "QUEUE_ITEM_NOT_FOUND",
          "Queue item was not found.",
        );
      }


      return item;
    }


    case "START": {
      const result =
        await startQueueItemForUser(
          userId,
          operation.entityId,
          tx,
          occurredAt,
        );


      if (
        result.kind ===
        "NOT_FOUND"
      ) {
        throw new QueueSyncError(
          404,
          "QUEUE_ITEM_NOT_FOUND",
          "Queue item was not found.",
        );
      }


      if (
        result.kind ===
        "DEFERRED"
      ) {
        throw new QueueSyncError(
          409,
          "QUEUE_ITEM_DEFERRED",
          "This queue item was still snoozed when the start occurred.",
        );
      }


      if (
        result.kind ===
        "INVALID_TRANSITION"
      ) {
        throw new QueueSyncError(
          409,
          "INVALID_QUEUE_ITEM_TRANSITION",
          "This queue item cannot be started from its current state.",
        );
      }


      return result.item;
    }


    case "SNOOZE": {
      const result =
        await snoozeQueueItemForUser(
          userId,
          operation.entityId,
          operation.payload
            .deferUntil,
          tx,
          occurredAt,
        );


      if (
        result.kind ===
        "NOT_FOUND"
      ) {
        throw new QueueSyncError(
          404,
          "QUEUE_ITEM_NOT_FOUND",
          "Queue item was not found.",
        );
      }


      if (
        result.kind ===
        "INVALID_DEFER_UNTIL"
      ) {
        throw new QueueSyncError(
          400,
          "INVALID_SNOOZE_TIME",
          "Snooze time must be after the operation time.",
        );
      }


      if (
        result.kind ===
        "INVALID_TRANSITION"
      ) {
        throw new QueueSyncError(
          409,
          "INVALID_QUEUE_ITEM_TRANSITION",
          "This queue item cannot be snoozed from its current state.",
        );
      }


      return result.item;
    }


    case "COMPLETE": {
      const currentItem =
        await getOwnedQueueItem(
          userId,
          operation.entityId,
          tx,
        );


      /**
       * Prevent impossible history such as:
       *
       * startedAt   = 3:00 PM
       * completedAt = 2:00 PM
       */
      if (
        currentItem?.startedAt &&
        occurredAt.getTime() <
        currentItem.startedAt.getTime()
      ) {
        throw new QueueSyncError(
          400,
          "INVALID_SYNC_TIME",
          "Completion time cannot be earlier than the task start time.",
        );
      }


      const result =
        await completeQueueItemForUser(
          userId,
          operation.entityId,
          tx,
          occurredAt,
        );


      if (
        result.kind ===
        "NOT_FOUND"
      ) {
        throw new QueueSyncError(
          404,
          "QUEUE_ITEM_NOT_FOUND",
          "Queue item was not found.",
        );
      }


      if (
        result.kind ===
        "INVALID_TRANSITION"
      ) {
        throw new QueueSyncError(
          409,
          "INVALID_QUEUE_ITEM_TRANSITION",
          "Only an in-progress queue item can be completed.",
        );
      }


      return result.item;
    }


    case "CANCEL": {
      const result =
        await cancelQueueItemForUser(
          userId,
          operation.entityId,
          tx,
        );


      if (
        result.kind ===
        "NOT_FOUND"
      ) {
        throw new QueueSyncError(
          404,
          "QUEUE_ITEM_NOT_FOUND",
          "Queue item was not found.",
        );
      }


      if (
        result.kind ===
        "INVALID_TRANSITION"
      ) {
        throw new QueueSyncError(
          409,
          "INVALID_QUEUE_ITEM_TRANSITION",
          "This queue item cannot be cancelled from its current state.",
        );
      }


      return result.item;
    }


    case "EXTEND": {
      const currentItem =
        await getOwnedQueueItem(
          userId,
          operation.entityId,
          tx,
        );


      if (
        currentItem?.startedAt &&
        occurredAt.getTime() <
        currentItem.startedAt.getTime()
      ) {
        throw new QueueSyncError(
          400,
          "INVALID_SYNC_TIME",
          "Timer extension cannot occur before the task was started.",
        );
      }


      const result =
        await extendQueueItemTimerForUser(
          userId,
          operation.entityId,
          operation.payload
            .additionalMinutes,
          tx,
          occurredAt,
        );


      if (
        result.kind ===
        "NOT_FOUND"
      ) {
        throw new QueueSyncError(
          404,
          "QUEUE_ITEM_NOT_FOUND",
          "Queue item was not found.",
        );
      }


      if (
        result.kind ===
        "INVALID_MINUTES"
      ) {
        throw new QueueSyncError(
          400,
          "INVALID_EXTENSION",
          "Timer extension must be a positive whole number.",
        );
      }


      if (
        result.kind ===
        "INVALID_TRANSITION"
      ) {
        throw new QueueSyncError(
          409,
          "INVALID_QUEUE_ITEM_TRANSITION",
          "Only an in-progress queue item can be extended.",
        );
      }


      return result.item;
    }
  }
}


/**
 * Compare an existing receipt with the operation
 * currently being retried.
 */
function assertReceiptMatches(
  receipt: {
    entityId:
      string;

    kind:
      string;

    requestHash:
      string;
  },

  operation:
    QueueSyncOperationInput,

  requestHash:
    string,
) {
  if (
    receipt.entityId !==
      operation.entityId ||

    receipt.kind !==
      operation.type ||

    receipt.requestHash !==
      requestHash
  ) {
    throw new QueueSyncError(
      409,
      "SYNC_OPERATION_CONFLICT",
      "This sync operation ID was already used for a different mutation.",
    );
  }
}


/**
 * Apply one Queue operation EXACTLY ONCE.
 */
export async function applyQueueSyncOperation(
  userId: string,

  operation:
    QueueSyncOperationInput,
) {
  const occurredAt =
    new Date(
      operation.occurredAt,
    );


  validateOccurredAt(
    occurredAt,
  );


  const requestHash =
    createRequestHash(
      operation,
    );


  try {
    return await prisma.$transaction(
      async tx => {
        /**
         * Fast path for ordinary retries.
         */
        const existingReceipt =
          await tx.queueSyncReceipt
            .findUnique({
              where: {
                userId_operationId: {
                  userId,

                  operationId:
                    operation.operationId,
                },
              },
            });


        if (
          existingReceipt
        ) {
          assertReceiptMatches(
            existingReceipt,
            operation,
            requestHash,
          );


          const item =
            await getOwnedQueueItem(
              userId,
              operation.entityId,
              tx,
            );


          return {
            operationId:
              operation.operationId,

            alreadyApplied:
              true,

            item,
          };
        }


        /**
         * IMPORTANT:
         *
         * Insert the receipt BEFORE changing the
         * QueueItem.
         *
         * It is still inside the SAME transaction.
         *
         * If the Queue mutation fails, PostgreSQL
         * rolls this receipt back too.
         *
         * If two identical requests race, the
         * compound primary key blocks the second
         * transaction before it can apply the
         * mutation twice.
         */
        await tx.queueSyncReceipt.create({
          data: {
            operationId:
              operation.operationId,

            userId,

            entityId:
              operation.entityId,

            kind:
              operation.type,

            requestHash,

            occurredAt,
          },
        });


        const item =
          await executeOperation(
            userId,
            operation,
            tx,
          );


        return {
          operationId:
            operation.operationId,

          alreadyApplied:
            false,

          item,
        };
      },
    );

  } catch (error) {
    /**
     * Concurrent duplicate:
     *
     * Request A inserts receipt and succeeds.
     * Request B raced with it and hit the unique
     * key.
     *
     * Request B's transaction is rolled back.
     *
     * Now inspect the committed receipt from A.
     */
    if (
      error instanceof
        Prisma.PrismaClientKnownRequestError &&

      error.code ===
        "P2002"
    ) {
      const existingReceipt =
        await prisma
          .queueSyncReceipt
          .findUnique({
            where: {
              userId_operationId: {
                userId,

                operationId:
                  operation.operationId,
              },
            },
          });


      if (
        existingReceipt
      ) {
        assertReceiptMatches(
          existingReceipt,
          operation,
          requestHash,
        );


        const item =
          await getOwnedQueueItem(
            userId,
            operation.entityId,
            prisma,
          );


        return {
          operationId:
            operation.operationId,

          alreadyApplied:
            true,

          item,
        };
      }
    }


    throw error;
  }
}