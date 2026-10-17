
import { z } from "zod";

/**
 * Daily time, not an absolute timestamp.
 *
 * Valid:
 *   07:30
 *   18:00
 *   23:45
 *
 * Invalid:
 *   7:30
 *   25:00
 *   10:99
 */
const localTimeSchema = z.string().regex(
  /^(?:[01]\d|2[0-3]):[0-5]\d$/,
  "Time must use HH:mm (24-hour format).",
);

/**
 * Recognize real IANA time zones.
 *
 * Example: Asia/Manila.
 *
 * The mobile device will supply its actual
 * time zone during the sync integration.
 */
function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: value,
    });

    return true;
  } catch {
    return false;
  }
}

export const userScheduleSchema = z.strictObject({
  wakeTime: localTimeSchema,
  workStartTime: localTimeSchema.nullable(),
  workEndTime: localTimeSchema.nullable(),
  sleepTime: localTimeSchema,

  timeZone: z.string().trim().min(1).max(64)
    .refine(
      isValidTimeZone,
      "Invalid IANA time zone.",
    ),
});

/**
 * expectedVersion:
 *
 * 0 = this account has no schedule yet.
 * 1 = editing version 1.
 * 2 = editing version 2.
 *
 * The server decides the next version.
 */
export const putUserScheduleSchema = z.strictObject({
  operationId: z.string().trim().min(1).max(128),

  expectedVersion: z.number().int().nonnegative(),

  schedule: userScheduleSchema,
});

export type PutUserScheduleInput =
  z.infer<typeof putUserScheduleSchema>;
