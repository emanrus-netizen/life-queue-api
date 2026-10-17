
import { prisma } from "../db/prisma";

import type {
    CompleteRoutineSessionInput,
    ExtendRoutineSessionInput,
    StartRoutineSessionInput,
} from "./routine-session-schema";

export class RoutineSessionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutineSessionConflictError";
  }
}

/**
 * Fetch only sessions belonging to this user.
 *
 * These are the historical facts used by Rhythm.
 */
export async function getRoutineSessionsForUser(
  userId: string,
) {
  return prisma.routineSession.findMany({
    where: {
      userId,
    },

    orderBy: [
      { startedAt: "asc" },
      { id: "asc" },
    ],
  });
}

/**
 * Start a new RoutineSession.
 *
 * SECURITY:
 * userId is supplied by requireAuth, not the phone.
 *
 * DATA INTEGRITY:
 * The routine must exist, belong to the same
 * account, and be active.
 */
export async function startRoutineSessionForUser(
  userId: string,
  input: StartRoutineSessionInput,
) {
  const routine = await prisma.lifeRoutine.findFirst({
    where: {
      id: input.routineId,
      userId,
    },
  });

  if (!routine) {
    return {
      kind: "NOT_FOUND" as const,
    };
  }

  if (!routine.isActive) {
    throw new RoutineSessionConflictError(
      "Inactive routines cannot be started.",
    );
  }

  const startedAt = new Date(input.startedAt);

  /**
   * Offline actions can be old.
   *
   * But we reject timestamps more than
   * five minutes into the future.
   */
  if (
    startedAt.getTime() >
    Date.now() + 5 * 60 * 1000
  ) {
    throw new RoutineSessionConflictError(
      "Session start time is in the future.",
    );
  }

  /**
   * For the current MVP, only one session should
   * be IN_PROGRESS for each account.
   *
   * NOTE:
   * This application-level check alone is not
   * concurrency-safe. Before multi-device release,
   * we must enforce the rule atomically in PostgreSQL.
   */
  const activeSession =
    await prisma.routineSession.findFirst({
      where: {
        userId,
        status: "IN_PROGRESS",
      },
    });

  if (activeSession) {
    throw new RoutineSessionConflictError(
      "Another routine session is already in progress.",
    );
  }

  /**
   * Prefer the exact timer recorded by the phone.
   * Otherwise calculate the normal preferred duration.
   */
  const timerEndsAt =
    input.timerEndsAt === null
      ? null
      : input.timerEndsAt
        ? new Date(input.timerEndsAt)
        : new Date(
            startedAt.getTime() +
            routine.preferredMinutes * 60_000,
          );

  const session = await prisma.routineSession.create({
    data: {
      id: input.id,

      userId,

      routineId: routine.id,

      status: "IN_PROGRESS",

      startedAt,

      timerEndsAt,
    },
  });

  return {
    kind: "CREATED" as const,
    session,
  };
}



/**
 * Complete an existing session for exactly one user.
 *
 * Important:
 * - A different account cannot complete the session.
 * - Only IN_PROGRESS can transition to COMPLETED.
 * - Duplicate completion with the same timestamp
 *   succeeds without altering historical data.
 */
export async function completeRoutineSessionForUser(
  userId: string,
  sessionId: string,
  input: CompleteRoutineSessionInput,
) {
  const session =
    await prisma.routineSession.findFirst({
      where: {
        id: sessionId,
        userId,
      },
    });

  if (!session) {
    return { kind: "NOT_FOUND" as const };
  }

  const completedAt = new Date(input.completedAt);

  if (
    completedAt.getTime() < session.startedAt.getTime() ||
    completedAt.getTime() > Date.now() + 5 * 60_000
  ) {
    return { kind: "INVALID_TIME" as const };
  }

  /**
   * A repeated delivery of the same completion
   * should not replace its original timestamp.
   */
  if (session.status === "COMPLETED") {
    if (
      session.completedAt?.getTime() ===
      completedAt.getTime()
    ) {
      return {
        kind: "COMPLETED" as const,
        session,
      };
    }

    return { kind: "INVALID_TRANSITION" as const };
  }

  /**
   * Atomic conditional update.
   *
   * Even if two devices attempt completion
   * simultaneously, only one can change
   * IN_PROGRESS into COMPLETED.
   */
  const updated =
    await prisma.routineSession.updateMany({
      where: {
        id: sessionId,
        userId,
        status: "IN_PROGRESS",
      },
      data: {
        status: "COMPLETED",
        completedAt,
      },
    });

  const latest =
    await prisma.routineSession.findFirst({
      where: {
        id: sessionId,
        userId,
      },
    });

  if (!latest) {
    return { kind: "NOT_FOUND" as const };
  }

  if (updated.count === 0) {
    if (
      latest.status === "COMPLETED" &&
      latest.completedAt?.getTime() ===
        completedAt.getTime()
    ) {
      return {
        kind: "COMPLETED" as const,
        session: latest,
      };
    }

    return { kind: "INVALID_TRANSITION" as const };
  }

  return {
    kind: "COMPLETED" as const,
    session: latest,
  };
}

/**
 * Extend a routine session using an absolute deadline.
 *
 * SECURITY:
 * - Only the authenticated owner can extend.
 * - A completed session cannot be extended.
 *
 * CONCURRENCY:
 * - We compare the previous deadline before writing.
 * - Identical retries do not add more minutes.
 * - Conflicting updates return CONFLICT.
 */
export async function extendRoutineSessionForUser(
  userId: string,
  sessionId: string,
  input: ExtendRoutineSessionInput,
) {
  const session =
    await prisma.routineSession.findFirst({
      where: {
        id: sessionId,
        userId,
      },
    });

  if (!session) {
    return {
      kind: "NOT_FOUND" as const,
    };
  }

  if (session.status !== "IN_PROGRESS") {
    return {
      kind: "INVALID_TRANSITION" as const,
    };
  }

  const occurredAt =
    new Date(input.occurredAt);

  const newDeadline =
    new Date(input.timerEndsAt);

  const expectedDeadline =
    input.expectedTimerEndsAt
      ? new Date(input.expectedTimerEndsAt)
      : null;

  /**
   * Match the mobile timer rule:
   *
   * If the old timer is still running,
   * extend from its previous deadline.
   *
   * If expired, extend from occurredAt.
   */
  const extensionBase = Math.max(
    occurredAt.getTime(),
    expectedDeadline?.getTime() ??
      occurredAt.getTime(),
  );

  const extensionMilliseconds =
    newDeadline.getTime() - extensionBase;

  /**
   * Reject impossible or unreasonable times.
   *
   * Allow five minutes of clock skew.
   * Limit a single extension to 24 hours.
   */
  if (
    occurredAt.getTime() <
      session.startedAt.getTime() ||
    occurredAt.getTime() >
      Date.now() + 5 * 60_000 ||
    extensionMilliseconds <= 0 ||
    extensionMilliseconds > 1440 * 60_000
  ) {
    return {
      kind: "INVALID_TIME" as const,
    };
  }

  /**
   * Identical retry:
   *
   * The server already has the requested
   * deadline. Don't add more time.
   */
  if (
    session.timerEndsAt?.getTime() ===
    newDeadline.getTime()
  ) {
    return {
      kind: "EXTENDED" as const,
      session,
    };
  }

  /**
   * Compare-and-set update.
   *
   * The database changes this deadline only
   * if the current deadline still equals the
   * deadline observed by the client.
   *
   * This is atomic inside PostgreSQL.
   */
  const updated =
    await prisma.routineSession.updateMany({
      where: {
        id: sessionId,
        userId,
        status: "IN_PROGRESS",
        timerEndsAt: expectedDeadline,
      },

      data: {
        timerEndsAt: newDeadline,
      },
    });

  const latest =
    await prisma.routineSession.findFirst({
      where: {
        id: sessionId,
        userId,
      },
    });

  if (!latest) {
    return {
      kind: "NOT_FOUND" as const,
    };
  }

  /**
   * A simultaneous retry may have committed
   * between our earlier read and updateMany.
   */
  if (updated.count === 0) {
    if (
      latest.status === "IN_PROGRESS" &&
      latest.timerEndsAt?.getTime() ===
        newDeadline.getTime()
    ) {
      return {
        kind: "EXTENDED" as const,
        session: latest,
      };
    }

    return {
      kind: "CONFLICT" as const,
    };
  }

  return {
    kind: "EXTENDED" as const,
    session: latest,
  };
}