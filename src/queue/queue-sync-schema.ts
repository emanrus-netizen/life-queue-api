import {
    z,
} from "zod";

import {
    createQueueItemSchema,
    extendQueueItemSchema,
    snoozeQueueItemSchema,
    updateQueueItemSchema,
} from "./queue-item-schema";


const operationIdSchema =
  z.string()
    .min(8)
    .max(128)
    .regex(
      /^qsync_[A-Za-z0-9_-]+$/,
      "Invalid Queue sync operation ID.",
    );


const entityIdSchema =
  z.string()
    .min(1)
    .max(191);


const occurredAtSchema =
  z.string()
    .datetime({
      offset: true,
    });


const baseFields = {
  operationId:
    operationIdSchema,

  entityId:
    entityIdSchema,

  occurredAt:
    occurredAtSchema,
};


/**
 * One sync request represents ONE logical
 * Queue mutation.
 *
 * The client may send the same operation again,
 * but it must reuse the same operationId.
 */
export const queueSyncOperationSchema =
  z.discriminatedUnion(
    "type",
    [
      z.object({
        ...baseFields,

        type:
          z.literal(
            "CREATE",
          ),

        payload:
          createQueueItemSchema,
      }).strict(),


      z.object({
        ...baseFields,

        type:
          z.literal(
            "UPDATE",
          ),

        payload:
          updateQueueItemSchema,
      }).strict(),


      z.object({
        ...baseFields,

        type:
          z.literal(
            "START",
          ),

        payload:
          z.null(),
      }).strict(),


      z.object({
        ...baseFields,

        type:
          z.literal(
            "SNOOZE",
          ),

        payload:
          snoozeQueueItemSchema,
      }).strict(),


      z.object({
        ...baseFields,

        type:
          z.literal(
            "COMPLETE",
          ),

        payload:
          z.null(),
      }).strict(),


      z.object({
        ...baseFields,

        type:
          z.literal(
            "CANCEL",
          ),

        payload:
          z.null(),
      }).strict(),


      z.object({
        ...baseFields,

        type:
          z.literal(
            "EXTEND",
          ),

        payload:
          extendQueueItemSchema,
      }).strict(),
    ],
  );


export type QueueSyncOperationInput =
  z.infer<
    typeof queueSyncOperationSchema
  >;