
import { z } from "zod";

/**
 * Starting a routine creates a RoutineSession.
 *
 * The mobile client generates the session ID
 * and timestamps so the action can happen offline.
 *
 * Ownership and lifecycle status are intentionally
 * excluded from the request.
 */
export const startRoutineSessionSchema = z.strictObject({
    id: z.string().trim().min(1).max(128),

    routineId: z.string().trim().min(1).max(128),

    startedAt: z.iso.datetime(),

    /**
     * This may have been calculated on the phone
     * when the user originally started the routine.
     *
     * Preserving it avoids changes to the timer
     * if cloud delivery happens hours later.
     */
    timerEndsAt: z.iso.datetime().nullable().optional(),
}).refine(
    data =>
        !data.timerEndsAt ||
        new Date(data.timerEndsAt).getTime() >
        new Date(data.startedAt).getTime(),
    {
        message: "Timer end must be after session start.",
        path: ["timerEndsAt"],
    },
);

export type StartRoutineSessionInput =
    z.infer<typeof startRoutineSessionSchema>;


/**
* The user may complete a session while offline.
*
* completedAt records WHEN completion happened,
* not when the server received the request.
*/
export const completeRoutineSessionSchema =
    z.strictObject({
        completedAt: z.iso.datetime(),
    });

export type CompleteRoutineSessionInput =
    z.infer<typeof completeRoutineSessionSchema>;

/**
* Extend a routine's timer.
*
* IMPORTANT:
* We send an absolute deadline, not just "+15".
*
* This lets us safely recognize identical retries.
*/
export const extendRoutineSessionSchema =
    z.strictObject({
        /**
         * What the client believed the previous
         * timer deadline was before this action.
         */
        expectedTimerEndsAt:
            z.iso.datetime().nullable(),

        /**
         * The exact new deadline calculated
         * when the user extended the timer.
         */
        timerEndsAt:
            z.iso.datetime(),

        /**
         * When the user performed this action.
         *
         * This is NOT the time the server
         * received the request.
         */
        occurredAt:
            z.iso.datetime(),
    });

export type ExtendRoutineSessionInput =
    z.infer<typeof extendRoutineSessionSchema>;