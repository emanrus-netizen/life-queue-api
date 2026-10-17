
import { z } from "zod";

/**
 * Validate untrusted API input.
 *
 * We use strict objects so clients cannot
 * secretly provide fields such as:
 *
 * userId
 * isActive
 * updatedAt
 *
 * Those are controlled by the backend.
 */
export const createRoutineSchema = z.strictObject({
    id: z.string().trim().min(1).max(128),

    name: z.string().trim().min(1).max(150),

    description: z.string().trim().max(2000).optional(),

    targetSessionsPerWeek: z.number()
        .int()
        .min(1)
        .max(7)
        .default(3),

    preferredMinutes: z.number()
        .int()
        .min(1)
        .max(1440)
        .default(30),

    preferredTime: z.enum([
        "ANYTIME",
        "MORNING",
        "AFTERNOON",
        "EVENING",
    ]).default("ANYTIME"),

    context: z.enum([
        "ANYWHERE",
        "HOME",
        "WORK",
        "COMPUTER",
        "PHONE",
        "ERRAND",
    ]).default("ANYWHERE"),

    energy: z.enum([
        "LOW",
        "MEDIUM",
        "HIGH",
    ]).optional(),

    /**
     * Client timestamps allow offline-created
     * routines to retain their creation time.
     */
    createdAt: z.iso.datetime(),
});

export type CreateRoutineInput =
    z.infer<typeof createRoutineSchema>;





/**
 * PATCH updates only the fields supplied.
 *
 * Unlike POST, we do not assign defaults.
 * Otherwise changing only a routine's name
 * could accidentally reset its weekly goal.
 *
 * Security:
 * strictObject rejects userId, id,
 * createdAt, updatedAt, etc.
 */
export const updateRoutineSchema = z.strictObject({
    name: z.string().trim().min(1).max(150).optional(),

    // null explicitly clears an optional field.
    description: z.string()
        .trim()
        .max(2000)
        .nullable()
        .optional(),

    targetSessionsPerWeek: z.number()
        .int()
        .min(1)
        .max(7)
        .optional(),

    preferredMinutes: z.number()
        .int()
        .min(1)
        .max(1440)
        .optional(),

    preferredTime: z.enum([
        "ANYTIME",
        "MORNING",
        "AFTERNOON",
        "EVENING",
    ]).optional(),

    context: z.enum([
        "ANYWHERE",
        "HOME",
        "WORK",
        "COMPUTER",
        "PHONE",
        "ERRAND",
    ]).optional(),

    energy: z.enum([
        "LOW",
        "MEDIUM",
        "HIGH",
    ]).nullable().optional(),

    // Deactivation preserves routine history.
    isActive: z.boolean().optional(),
}).refine(
    data => Object.values(data).some(
        value => value !== undefined,
    ),
    {
        message: "At least one field must be provided.",
    },
);

export type UpdateRoutineInput =
    z.infer<typeof updateRoutineSchema>;



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