
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

import { prisma } from "../db/prisma";

import type {
    PutUserScheduleInput,
} from "./user-schedule-schema";

/**
 * Convert a database record into the
 * public response format.
 *
 * Never send the account's internal userId
 * as a field the client must trust.
 */
function toScheduleDto(schedule: {
  wakeTime: string;
  workStartTime: string | null;
  workEndTime: string | null;
  sleepTime: string;
  timeZone: string;
  version: number;
  updatedAt: Date;
}) {
  return {
    wakeTime: schedule.wakeTime,
    workStartTime: schedule.workStartTime,
    workEndTime: schedule.workEndTime,
    sleepTime: schedule.sleepTime,
    timeZone: schedule.timeZone,
    version: schedule.version,
    updatedAt: schedule.updatedAt.toISOString(),
  };
}

export async function getUserScheduleForUser(
  userId: string,
) {
  const schedule = await prisma.userSchedule.findUnique({
    where: { userId },
  });

  return schedule ? toScheduleDto(schedule) : null;
}

function hashRequest(input: PutUserScheduleInput): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

type WriteResult =
  | {
      kind: "OK";
      body: Prisma.JsonValue;
    }
  | { kind: "OPERATION_ID_REUSED" }
  | { kind: "VERSION_CONFLICT" };

export async function putUserScheduleForUser(
  userId: string,
  input: PutUserScheduleInput,
): Promise<WriteResult> {
  const requestHash = hashRequest(input);

  const receiptWhere = {
    userId_operationId: {
      userId,
      operationId: input.operationId,
    },
  };

  /**
   * A retry must return its ORIGINAL response.
   *
   * Check the receipt before looking at the
   * current schedule version.
   */
  function checkReceipt(receipt: {
    requestHash: string;
    responseJson: Prisma.JsonValue;
  }): WriteResult {
    if (receipt.requestHash !== requestHash) {
      return { kind: "OPERATION_ID_REUSED" };
    }

    return {
      kind: "OK",
      body: receipt.responseJson,
    };
  }

  try {
    return await prisma.$transaction(async tx => {
      const previousReceipt =
        await tx.userScheduleSyncReceipt.findUnique({
          where: receiptWhere,
        });

      if (previousReceipt) {
        return checkReceipt(previousReceipt);
      }

      const existing = await tx.userSchedule.findUnique({
        where: { userId },
      });

      const fields = {
        wakeTime: input.schedule.wakeTime,
        workStartTime: input.schedule.workStartTime,
        workEndTime: input.schedule.workEndTime,
        sleepTime: input.schedule.sleepTime,
        timeZone: input.schedule.timeZone,
      };

      if (!existing) {
        /**
         * No schedule exists yet.
         *
         * Only a version-0 request is allowed
         * to create the first schedule.
         */
        if (input.expectedVersion !== 0) {
          return {
            kind: "VERSION_CONFLICT" as const,
          };
        }

        await tx.userSchedule.create({
          data: {
            userId,
            ...fields,
          },
        });
      } else {
        /**
         * Optimistic concurrency control:
         *
         * Only modify the schedule if its
         * current version matches what the
         * client previously observed.
         */
        if (existing.version !== input.expectedVersion) {
          return {
            kind: "VERSION_CONFLICT" as const,
          };
        }

        const result = await tx.userSchedule.updateMany({
          where: {
            userId,
            version: input.expectedVersion,
          },
          data: {
            ...fields,
            version: {
              increment: 1,
            },
          },
        });

        if (result.count !== 1) {
          return {
            kind: "VERSION_CONFLICT" as const,
          };
        }
      }

      const saved = await tx.userSchedule.findUniqueOrThrow({
        where: { userId },
      });

      const body = {
        ack: {
          operationId: input.operationId,
          version: saved.version,
        },
        schedule: toScheduleDto(saved),
      };

      /**
       * This receipt and the schedule update
       * commit together.
       *
       * If either write fails, both roll back.
       */
      await tx.userScheduleSyncReceipt.create({
        data: {
          userId,
          operationId: input.operationId,
          requestHash,
          responseJson: body,
        },
      });

      return {
        kind: "OK" as const,
        body,
      };
    });
  } catch (error) {
    /**
     * Concurrent first saves can collide on
     * the unique userId or operationId.
     *
     * Resolve a committed identical retry
     * by reading its receipt again.
     */
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const receipt =
        await prisma.userScheduleSyncReceipt.findUnique({
          where: receiptWhere,
        });

      if (receipt) {
        return checkReceipt(receipt);
      }

      return { kind: "VERSION_CONFLICT" };
    }

    throw error;
  }
}
