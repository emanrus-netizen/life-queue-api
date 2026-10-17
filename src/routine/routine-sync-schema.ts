
import { z } from "zod";

import {
    createRoutineSchema,
    updateRoutineSchema,
} from "./routine-schema";

/**
 * Properties shared by every sync command.
 *
 * operationId:
 *   Identifies one logical user action.
 *
 * entityId:
 *   Identifies the routine being modified.
 *
 * occurredAt:
 *   When the action happened on the phone.
 */
const baseOperation = {
    operationId: z.string().trim().min(1).max(128),
    entityId: z.string().trim().min(1).max(128),
    occurredAt: z.iso.datetime(),
};

/**
 * CREATE_ROUTINE
 *
 * The whole routine is included because it
 * does not exist in PostgreSQL yet.
 */
export const routineCreateSyncSchema =
    z.strictObject({
        ...baseOperation,

        kind: z.literal("CREATE_ROUTINE"),

        payload: createRoutineSchema,
    }).refine(
        operation =>
            operation.entityId === operation.payload.id,
        {
            message: "Entity ID must match routine ID.",
            path: ["entityId"],
        },
    );

/**
 * UPDATE_ROUTINE
 *
 * We reuse the PATCH validation rules.
 *
 * This prevents clients from changing
 * protected properties such as:
 *
 * - id
 * - userId
 * - createdAt
 * - updatedAt
 */
export const routineUpdateSyncSchema =
    z.strictObject({
        ...baseOperation,

        kind: z.literal("UPDATE_ROUTINE"),

        payload: updateRoutineSchema,
    });


export type RoutineSyncInput =
    z.infer<typeof routineSyncOperationSchema>;


/**
* START_SESSION
*
* The phone determines the session's exact
* start time and timer deadline.
*
* We require timerEndsAt explicitly:
* - ISO string = a timed session
* - null = a session without a deadline
*
* This avoids recalculating the timer when
* an offline operation reaches the server.
*/
export const routineStartSessionSyncSchema =
    z.strictObject({
        ...baseOperation,

        kind: z.literal("START_SESSION"),

        payload: z.strictObject({
            id: z.string().trim().min(1).max(128),

            routineId: z.string().trim().min(1).max(128),

            startedAt: z.iso.datetime(),

            timerEndsAt: z.iso.datetime().nullable(),
        }).refine(
            payload =>
                payload.timerEndsAt === null ||
                Date.parse(payload.timerEndsAt) >
                Date.parse(payload.startedAt),
            {
                message: "Timer must end after session start.",
                path: ["timerEndsAt"],
            },
        ),
    }).refine(
        operation =>
            operation.entityId === operation.payload.id,
        {
            message: "Entity ID must match session ID.",
            path: ["entityId"],
        },
    );

/**
* EXTEND_SESSION
*
* The phone sends the exact new deadline.
*
* We compare it against the deadline the
* phone observed before the extension.
*/
export const routineExtendSessionSyncSchema =
    z.strictObject({
        ...baseOperation,

        kind: z.literal("EXTEND_SESSION"),

        payload: z.strictObject({
            expectedTimerEndsAt:
                z.iso.datetime().nullable(),

            timerEndsAt:
                z.iso.datetime(),
        }),
    });

/**
* COMPLETE_SESSION
*
* completedAt is the time the user tapped
* Complete, not the time the phone reconnected.
*/
export const routineCompleteSessionSyncSchema =
    z.strictObject({
        ...baseOperation,

        kind: z.literal("COMPLETE_SESSION"),

        payload: z.strictObject({
            completedAt: z.iso.datetime(),
        }),
    });
/**
 * The endpoint accepts either operation.
 *
 * As Life Queue grows, we will add:
 * START_SESSION, EXTEND_SESSION,
 * and COMPLETE_SESSION here.
 */
export const routineSyncOperationSchema =
    z.union([
        routineCreateSyncSchema,
        routineUpdateSyncSchema,
        routineStartSessionSyncSchema,
        routineExtendSessionSyncSchema,
         routineCompleteSessionSyncSchema,
    ]);

