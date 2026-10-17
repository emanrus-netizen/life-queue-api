import { z } from "zod";

const queueItemStatusSchema = z.enum([
    "ACTIVE",
    "IN_PROGRESS",
    "COMPLETED",
    "CANCELLED"
])

const queuePrioritySchema = z.enum([
    "LOW",
    "NORMAL",
    "HIGH",
    "URGENT"
]);

const queueContextSchema = z.enum([
    "ANYWHERE",
    "HOME",
    "COMPUTER",
    "PHONE",
    "ERRAND",
    "WORK"
])

const energyLevelSchema = z.enum([
    "LOW",
    "HIGH",
    "MEDIUM"
]);


/**
 * Dates crossing an HTTP/JSON boundary are
 * strings rather than JavaScript Date objects.
 *
 * The service layer will turn these back into
 * Date instances before Prisma receives them.
 */

const isoDateSchema = z.string().datetime({
    offset: true
})


/**
 * Creating a QueueItem.
 *
 * SECURITY:
 *
 * There is deliberately NO userId here.
 *
 * Ownership comes from:
 *
 * Authorization header
 *       ↓
 * requireAuth()
 *       ↓
 * request.auth.user.id
 */
export const createQueueItemSchema =
    z.object({
        id:
            z.string()
                .trim()
                .min(1)
                .max(128),

        title:
            z.string()
                .trim()
                .min(1)
                .max(200),

        description:
            z.string()
                .max(4000)
                .default(""),

        priority:
            queuePrioritySchema
                .default("NORMAL"),

        /**
         * This is the ORIGINAL estimate.
         *
         * It may be chosen when the task is created,
         * but our normal PATCH endpoint cannot rewrite
         * it later.
         */
        estimatedMinutes:
            z.number()
                .int()
                .positive()
                .max(
                    7 * 24 * 60,
                )
                .optional(),

        dueAt:
            isoDateSchema
                .nullable()
                .optional(),

        context:
            queueContextSchema
                .default("ANYWHERE"),

        energy:
            energyLevelSchema
                .nullable()
                .optional(),

        /**
         * We preserve the real creation time because
         * later an offline-created task may reach the
         * server after it was actually created.
         */
        createdAt:
            isoDateSchema,
    })
        .strict();

/**
 * Fields that may actually be changed after
 * a task has been created.
 *
 * Notice what is NOT here:
 *
 * - id
 * - userId
 * - createdAt
 * - updatedAt
 *
 * Identity and ownership are immutable.
 */

export const updateQueueItemSchema =
    z.object({
        title:
            z.string()
                .trim()
                .min(1)
                .max(200)
                .optional(),

        description:
            z.string()
                .max(4000)
                .optional(),

        priority:
            queuePrioritySchema
                .optional(),

        dueAt:
            isoDateSchema
                .nullable()
                .optional(),

        context:
            queueContextSchema
                .optional(),

        energy:
            energyLevelSchema
                .nullable()
                .optional(),
    })
        .strict()
        .refine(
            value =>
                Object.keys(
                    value,
                ).length > 0,
            {
                message:
                    "At least one field must be provided.",
            },
        );

export type CreateQueueItemInput =
    z.infer<
        typeof createQueueItemSchema
    >;


export type UpdateQueueItemInput =
    z.infer<
        typeof updateQueueItemSchema
    >;


/**
* Snooze does not change QueueItem status.
*
* It only establishes the earliest time at
* which the task may become eligible again.
*/
export const snoozeQueueItemSchema =
    z.object({
        deferUntil:
            isoDateSchema,
    })
        .strict();


export type SnoozeQueueItemInput =
    z.infer<
        typeof snoozeQueueItemSchema
    >;

/**
* Historical QueueItem imported from an older
* local-only Life Queue installation.
*
* This schema is intentionally separate from
* createQueueItemSchema.
*
* Normal creation must NEVER be able to bypass
* lifecycle commands.
*/
const historicalQueueItemSchema =
    z.object({
        id:
            z.string()
                .trim()
                .min(1)
                .max(128),

        title:
            z.string()
                .trim()
                .min(1)
                .max(200),

        description:
            z.string()
                .max(4000),

        status:
            queueItemStatusSchema,

        priority:
            queuePrioritySchema,

        estimatedMinutes:
            z.number()
                .int()
                .positive()
                .max(
                    7 * 24 * 60,
                )
                .nullable()
                .optional(),

        dueAt:
            isoDateSchema
                .nullable()
                .optional(),

        deferUntil:
            isoDateSchema
                .nullable()
                .optional(),

        context:
            queueContextSchema,

        energy:
            energyLevelSchema
                .nullable()
                .optional(),

        startedAt:
            isoDateSchema
                .nullable()
                .optional(),

        timerEndsAt:
            isoDateSchema
                .nullable()
                .optional(),

        completedAt:
            isoDateSchema
                .nullable()
                .optional(),

        createdAt:
            isoDateSchema,
    })
        .strict();


export const importQueueItemsSchema =
    z.object({
        items:
            z.array(
                historicalQueueItemSchema,
            )
                .min(1)
                .max(500),
    })
        .strict();


export type ImportQueueItemsInput =
    z.infer<
        typeof importQueueItemsSchema
    >;
/**
 * Body accepted by:
 *
 * POST /queue-items/:id/extend
 *
 * We accept only a positive whole number.
 *
 * The server calculates timerEndsAt itself.
 * The client is NOT allowed to submit a new
 * timerEndsAt directly.
 */
export const extendQueueItemSchema =
  z
    .object({
      additionalMinutes:
        z
          .number()
          .int()
          .positive(),
    })
    .strict();