
import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";


import type {
    CreateRoutineInput,
    UpdateRoutineInput,
} from "./routine-schema";

/**
 * Return only routines owned by this account.
 *
 * SECURITY:
 * The userId argument must come from
 * verified authentication middleware.
 *
 * Do not accept a userId from request.body.
 */
export async function getRoutinesForUser(
  userId: string,
) {
  return prisma.lifeRoutine.findMany({
    where: {
      userId,
    },

    orderBy: [
      {
        createdAt: "asc",
      },
      {
        id: "asc",
      },
    ],
  });
}

/**
 * The frontend may create a routine offline.
 *
 * We preserve the original creation time,
 * but reject timestamps too far in the future.
 */
export class InvalidRoutineDateError extends Error {
  constructor() {
    super("Routine creation time is invalid.");

    this.name = "InvalidRoutineDateError";
  }
}

/**
 * Create one routine for the authenticated user.
 *
 * Prisma receives the trusted userId
 * separately from the validated input.
 */
export async function createRoutineForUser(
  userId: string,
  input: CreateRoutineInput,
) {
  const createdAt = new Date(input.createdAt);

  const maximumAllowedTime =
    Date.now() + 5 * 60 * 1000;

  if (
    createdAt.getTime() > maximumAllowedTime
  ) {
    throw new InvalidRoutineDateError();
  }

  return prisma.lifeRoutine.create({
    data: {
      id: input.id,

      // Trusted identity from requireAuth.
      userId,

      name: input.name,

      description: input.description,

      targetSessionsPerWeek:
        input.targetSessionsPerWeek,

      preferredMinutes:
        input.preferredMinutes,

      preferredTime:
        input.preferredTime,

      context:
        input.context,

      energy:
        input.energy,

      // New routines always begin active.
      isActive: true,

      createdAt,
    },
  });
}



/**
 * Update a routine belonging to exactly one user.
 *
 * SECURITY:
 *
 * Never do this:
 *
 * prisma.lifeRoutine.update({
 *   where: { id: routineId }
 * })
 *
 * That finds a routine by ID without enforcing
 * the authenticated owner's identity.
 *
 * Instead, use the compound ownership key.
 */
export async function updateRoutineForUser(
  userId: string,
  routineId: string,
  changes: UpdateRoutineInput,
) {
  try {
    return await prisma.lifeRoutine.update({
      where: {
        id_userId: {
          id: routineId,
          userId,
        },
      },

      /**
       * Only validated editable fields arrive
       * here from updateRoutineSchema.
       *
       * Undefined fields are omitted by Zod
       * or not supplied by the caller.
       */
      data: {
        ...changes,
      },
    });

  } catch (error) {
    /**
     * P2025 means Prisma could not find
     * a matching record.
     *
     * That includes BOTH:
     *
     * - nonexistent routine
     * - routine owned by another account
     *
     * We intentionally treat them identically.
     */
    if (
      error instanceof
        Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return null;
    }

    throw error;
  }
}


