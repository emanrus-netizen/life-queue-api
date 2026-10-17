
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

import { prisma } from "../db/prisma";

import type {
    RoutineSyncInput,
} from "./routine-sync-schema";

/**
 * Our service returns one of these outcomes.
 *
 * The router is responsible for translating
 * them into appropriate HTTP status codes.
 */
type RoutineSyncResult =
    | {
        kind: "ACK";
        ack: Prisma.JsonValue;
    }
    | { kind: "INVALID_TIME" }
    | { kind: "NOT_FOUND" }
    | { kind: "ENTITY_CONFLICT" }
    | { kind: "INACTIVE_ROUTINE" }
    | { kind: "SESSION_CONFLICT" }
    | { kind: "OPERATION_ID_REUSED" }
    | { kind: "INVALID_EXTENSION_TIME" }
    | { kind: "INVALID_TRANSITION" }
    | { kind: "SESSION_TIMER_CONFLICT" }
    | { kind: "INVALID_COMPLETION_TIME" }

/**
 * Fingerprint the operation's contents.
 *
 * The operationId is deliberately excluded
 * because it is already the receipt's key.
 *
 * IMPORTANT:
 * Offline retries must preserve the original
 * operation data, including the timestamps.
 */
function hashOperation(
    operation: RoutineSyncInput,
): string {
    const logicalRequest = {
        kind: operation.kind,
        entityId: operation.entityId,
        occurredAt: operation.occurredAt,
        payload: operation.payload,
    };

    return createHash("sha256")
        .update(JSON.stringify(logicalRequest))
        .digest("hex");
}

/**
 * Determine whether an existing receipt
 * belongs to an identical retry.
 *
 * Same ID + same request = ACK
 * Same ID + different request = conflict
 */
function checkExistingReceipt(
    receipt: {
        requestHash: string;
        responseJson: Prisma.JsonValue;
    },
    expectedHash: string,
): RoutineSyncResult {
    if (receipt.requestHash !== expectedHash) {
        return {
            kind: "OPERATION_ID_REUSED",
        };
    }

    return {
        kind: "ACK",
        ack: receipt.responseJson,
    };
}

/**
 * Apply an authenticated Routine operation.
 *
 * SECURITY:
 * The userId comes from requireAuth.
 *
 * IDEMPOTENCY:
 * A previously applied operation returns
 * its original receipt.
 *
 * ATOMICITY:
 * The domain mutation and receipt share
 * one database transaction.
 */
export async function applyRoutineSyncOperation(
    userId: string,
    operation: RoutineSyncInput,
): Promise<RoutineSyncResult> {
    const requestHash =
        hashOperation(operation);

    const occurredAt =
        new Date(operation.occurredAt);

    const futureLimit =
        Date.now() + 5 * 60_000;

    /**
     * Reject actions from too far in the future.
     *
     * We still accept old timestamps because
     * users may synchronize after being offline.
     */
    if (occurredAt.getTime() > futureLimit) {
        return { kind: "INVALID_TIME" };
    }

    if (
        operation.kind === "CREATE_ROUTINE" &&
        new Date(
            operation.payload.createdAt,
        ).getTime() > futureLimit
    ) {
        return { kind: "INVALID_TIME" };
    }

    const receiptKey = {
        userId,
        operationId: operation.operationId,
    };

    try {
        return await prisma.$transaction(
            async tx => {
                /**
                 * STEP 1:
                 * Has PostgreSQL already applied
                 * this operation for this account?
                 */
                const existing =
                    await tx.routineSyncReceipt.findUnique({
                        where: {
                            userId_operationId: receiptKey,
                        },
                    });

                if (existing) {
                    return checkExistingReceipt(
                        existing,
                        requestHash,
                    );
                }

                /**
                 * STEP 2:
                 * Apply exactly one domain mutation.
                 *
                 * TypeScript narrows operation.payload
                 * according to operation.kind.
                 */
                switch (operation.kind) {
                    case "CREATE_ROUTINE": {
                        await tx.lifeRoutine.create({
                            data: {
                                id: operation.entityId,
                                userId,

                                name: operation.payload.name,

                                description:
                                    operation.payload.description ??
                                    null,

                                targetSessionsPerWeek:
                                    operation.payload
                                        .targetSessionsPerWeek,

                                preferredMinutes:
                                    operation.payload
                                        .preferredMinutes,

                                preferredTime:
                                    operation.payload
                                        .preferredTime,

                                context:
                                    operation.payload.context,

                                energy:
                                    operation.payload.energy ?? null,

                                isActive: true,

                                createdAt: new Date(
                                    operation.payload.createdAt,
                                ),
                            },
                        });

                        break;
                    }

                    case "UPDATE_ROUTINE": {
                        /**
                         * updateMany is used here because it
                         * allows a compound ownership filter.
                         *
                         * No routine belonging to another
                         * user can be changed.
                         *
                         * The payload is already validated
                         * using updateRoutineSchema.
                         */
                        const updated =
                            await tx.lifeRoutine.updateMany({
                                where: {
                                    id: operation.entityId,
                                    userId,
                                },

                                data: {
                                    ...operation.payload,
                                },
                            });

                        if (updated.count === 0) {
                            /**
                             * Same result for:
                             * - missing routine
                             * - another user's routine
                             */
                            return {
                                kind: "NOT_FOUND" as const,
                            };
                        }

                        break;
                    }
                    case "START_SESSION": {
                        const payload = operation.payload;

                        const startedAt = new Date(payload.startedAt);

                        /**
                         * Offline starts may have occurred hours
                         * or days ago.
                         *
                         * We reject only timestamps too far
                         * into the future.
                         */
                        if (
                            startedAt.getTime() >
                            Date.now() + 5 * 60_000
                        ) {
                            return {
                                kind: "INVALID_TIME" as const,
                            };
                        }

                        /**
                         * SECURITY:
                         *
                         * Confirm the routine belongs to the
                         * authenticated user.
                         *
                         * Knowing someone else's routine ID
                         * does not authorize starting it.
                         */
                        const routine =
                            await tx.lifeRoutine.findFirst({
                                where: {
                                    id: payload.routineId,
                                    userId,
                                },

                                select: {
                                    id: true,
                                    isActive: true,
                                },
                            });

                        if (!routine) {
                            return {
                                kind: "NOT_FOUND" as const,
                            };
                        }

                        if (!routine.isActive) {
                            return {
                                kind: "INACTIVE_ROUTINE" as const,
                            };
                        }

                        /**
                         * BUSINESS RULE:
                         *
                         * A user can have only one IN_PROGRESS
                         * routine session.
                         *
                         * This check gives a useful response.
                         *
                         * PostgreSQL's partial unique index
                         * remains the final concurrency safeguard.
                         */
                        const activeSession =
                            await tx.routineSession.findFirst({
                                where: {
                                    userId,
                                    status: "IN_PROGRESS",
                                },

                                select: {
                                    id: true,
                                },
                            });

                        if (activeSession) {
                            return {
                                kind: "SESSION_CONFLICT" as const,
                            };
                        }

                        /**
                         * DATA INTEGRITY:
                         *
                         * Preserve timestamps supplied by the
                         * offline operation.
                         *
                         * Do not use new Date() as startedAt.
                         * That would change the session's history.
                         */
                        await tx.routineSession.create({
                            data: {
                                id: payload.id,

                                userId,

                                routineId: routine.id,

                                status: "IN_PROGRESS",

                                startedAt,

                                timerEndsAt:
                                    payload.timerEndsAt === null
                                        ? null
                                        : new Date(payload.timerEndsAt),
                            },
                        });

                        /**
                         * Do not create the receipt here!
                         *
                         * The existing code after this switch
                         * creates a receipt in the SAME transaction.
                         */
                        break;
                    }

                    case "EXTEND_SESSION": {
                        /**
                         * 1. Find the session for the
                         * authenticated user only.
                         */
                        const session =
                            await tx.routineSession.findFirst({
                                where: {
                                    id: operation.entityId,
                                    userId,
                                },
                            });

                        if (!session) {
                            return {
                                kind: "NOT_FOUND" as const,
                            };
                        }

                        /**
                         * 2. Only active sessions can
                         * have their timers extended.
                         */
                        if (session.status !== "IN_PROGRESS") {
                            return {
                                kind: "INVALID_TRANSITION" as const,
                            };
                        }

                        const expectedDeadline =
                            operation.payload.expectedTimerEndsAt
                                ? new Date(
                                    operation.payload.expectedTimerEndsAt,
                                )
                                : null;

                        const newDeadline =
                            new Date(operation.payload.timerEndsAt);

                        /**
                         * 3. Reproduce the mobile timer rule.
                         *
                         * Still running:
                         *   extend from previous deadline.
                         *
                         * Already expired:
                         *   extend from the action time.
                         */
                        const extensionBase = Math.max(
                            occurredAt.getTime(),
                            expectedDeadline?.getTime() ??
                            occurredAt.getTime(),
                        );

                        const extensionMilliseconds =
                            newDeadline.getTime() - extensionBase;

                        /**
                         * Reject impossible timestamps or
                         * extensions exceeding 24 hours.
                         *
                         * The shared service already checks
                         * whether occurredAt is too far ahead
                         * of the server's current time.
                         */
                        if (
                            occurredAt.getTime() <
                            session.startedAt.getTime() ||
                            extensionMilliseconds <= 0 ||
                            extensionMilliseconds > 24 * 60 * 60_000
                        ) {
                            return {
                                kind: "INVALID_EXTENSION_TIME" as const,
                            };
                        }

                        /**
                         * 4. ATOMIC COMPARE-AND-SET.
                         *
                         * Update only if:
                         * - this user owns the session
                         * - the session is still in progress
                         * - the previous deadline matches
                         *
                         * This prevents stale updates from
                         * overwriting newer timer changes.
                         */
                        const updated =
                            await tx.routineSession.updateMany({
                                where: {
                                    id: operation.entityId,
                                    userId,
                                    status: "IN_PROGRESS",
                                    timerEndsAt: expectedDeadline,
                                },

                                data: {
                                    timerEndsAt: newDeadline,
                                },
                            });

                        if (updated.count !== 1) {
                            return {
                                kind: "SESSION_TIMER_CONFLICT" as const,
                            };
                        }

                        /**
                         * Do not create a receipt here.
                         *
                         * The existing receipt creation AFTER
                         * the switch runs inside this same
                         * transaction.
                         */
                        break;
                    }

                    case "COMPLETE_SESSION": {
                        /**
                         * SECURITY:
                         * A session must belong to the
                         * authenticated user.
                         */
                        const session =
                            await tx.routineSession.findFirst({
                                where: {
                                    id: operation.entityId,
                                    userId,
                                },
                            });

                        if (!session) {
                            return {
                                kind: "NOT_FOUND" as const,
                            };
                        }

                        const completedAt =
                            new Date(operation.payload.completedAt);

                        /**
                         * HISTORY VALIDATION:
                         *
                         * Completion cannot happen before Start
                         * or too far into the future.
                         *
                         * Old offline timestamps are allowed.
                         */
                        if (
                            completedAt.getTime() <
                            session.startedAt.getTime() ||
                            completedAt.getTime() >
                            Date.now() + 5 * 60_000
                        ) {
                            return {
                                kind: "INVALID_COMPLETION_TIME" as const,
                            };
                        }

                        /**
                         * Only IN_PROGRESS may transition
                         * to COMPLETED.
                         */
                        if (session.status !== "IN_PROGRESS") {
                            return {
                                kind: "INVALID_TRANSITION" as const,
                            };
                        }

                        /**
                         * ATOMIC STATE TRANSITION:
                         *
                         * Two devices might attempt to complete
                         * the same session simultaneously.
                         *
                         * Only one update can successfully change
                         * IN_PROGRESS into COMPLETED.
                         */
                        const updated =
                            await tx.routineSession.updateMany({
                                where: {
                                    id: operation.entityId,
                                    userId,
                                    status: "IN_PROGRESS",
                                },

                                data: {
                                    status: "COMPLETED",
                                    completedAt,
                                },
                            });

                        if (updated.count !== 1) {
                            /**
                             * A concurrent delivery of this SAME
                             * operation might just have committed.
                             *
                             * Check for its receipt before treating
                             * the attempt as a conflicting action.
                             */
                            const lateReceipt =
                                await tx.routineSyncReceipt.findUnique({
                                    where: {
                                        userId_operationId: receiptKey,
                                    },
                                });

                            if (lateReceipt) {
                                return checkExistingReceipt(
                                    lateReceipt,
                                    requestHash,
                                );
                            }

                            return {
                                kind: "INVALID_TRANSITION" as const,
                            };
                        }

                        /**
                         * The existing code AFTER this switch
                         * creates the operation receipt.
                         *
                         * Both writes happen in one transaction.
                         */
                        break;
                    }

                }

                /**
                 * STEP 3:
                 * Build an acknowledgment that remains
                 * stable across retries.
                 */
                const ack = {
                    operationId: operation.operationId,
                    kind: operation.kind,
                    entityId: operation.entityId,
                };

                /**
                 * STEP 4:
                 * Record the receipt in the SAME
                 * transaction as the domain mutation.
                 *
                 * If this write fails, the domain
                 * mutation is rolled back as well.
                 */
                await tx.routineSyncReceipt.create({
                    data: {
                        ...receiptKey,

                        entityId: operation.entityId,
                        kind: operation.kind,

                        requestHash,
                        occurredAt,

                        responseJson: ack,
                    },
                });

                return {
                    kind: "ACK" as const,
                    ack,
                };
            },
        );
    } catch (error) {
        /**
         * Simultaneous deliveries can race.
         *
         * When a unique constraint fails,
         * inspect the receipt after rollback.
         */
        if (
            error instanceof
            Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
        ) {
            const receipt =
                await prisma.routineSyncReceipt.findUnique({
                    where: {
                        userId_operationId: receiptKey,
                    },
                });

            if (receipt) {
                return checkExistingReceipt(
                    receipt,
                    requestHash,
                );
            }

            /**
 * No matching receipt exists.
 *
 * For START_SESSION, a unique constraint
 * may have rejected either:
 *
 * - a duplicate session ID
 * - a second active session
 */
            if (operation.kind === "START_SESSION") {
                return {
                    kind: "SESSION_CONFLICT",
                };
            }

            return {
                kind: "ENTITY_CONFLICT",
            };
        }

        throw error;
    }
}
