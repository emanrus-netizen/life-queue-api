
import { Router } from "express";

import {
    requireAuth,
} from "../auth/require-auth";

import {
    routineSyncOperationSchema,
} from "./routine-sync-schema";

import {
    applyRoutineSyncOperation,
} from "./routine-sync-service";

export const routineSyncRouter = Router();

/**
 * POST /routine-sync/operations
 *
 * Deliver one durable mutation from
 * the authenticated user's outbox.
 */
routineSyncRouter.post(
    "/operations",
    requireAuth,

    async (request, response) => {
        const parsed =
            routineSyncOperationSchema.safeParse(
                request.body,
            );

        if (!parsed.success) {
            response.status(400).json({
                error: {
                    code: "INVALID_ROUTINE_SYNC_OPERATION",
                    message: "Sync operation is invalid.",
                    details: parsed.error.flatten(),
                },
            });

            return;
        }

        try {
            const result =
                await applyRoutineSyncOperation(
                    request.auth!.user.id,
                    parsed.data,
                );

            switch (result.kind) {
                case "ACK":
                    response.status(200).json({
                        ack: result.ack,
                    });
                    return;

                case "INVALID_TIME":
                    response.status(400).json({
                        error: {
                            code: "INVALID_OPERATION_TIME",
                            message: "Operation time is invalid.",
                        },
                    });
                    return;

                case "NOT_FOUND":
                    response.status(404).json({
                        error: {
                            code: "ROUTINE_NOT_FOUND",
                            message: "Routine was not found.",
                        },
                    });
                    return;

                case "OPERATION_ID_REUSED":
                    response.status(409).json({
                        error: {
                            code: "OPERATION_ID_REUSED",
                            message:
                                "Operation ID was used with different data.",
                        },
                    });
                    return;

                case "ENTITY_CONFLICT":
                    response.status(409).json({
                        error: {
                            code: "ROUTINE_ALREADY_EXISTS",
                            message: "Routine ID already exists.",
                        },
                    });
                    return;
                case "INACTIVE_ROUTINE":
                    response.status(409).json({
                        error: {
                            code: "INACTIVE_ROUTINE",
                            message:
                                "Inactive routines cannot start sessions.",
                        },
                    });
                    return;

                case "SESSION_CONFLICT":
                    response.status(409).json({
                        error: {
                            code: "ROUTINE_SESSION_CONFLICT",
                            message:
                                "Routine session could not be started.",
                        },
                    });
                    return;
                case "INVALID_EXTENSION_TIME":
                    response.status(400).json({
                        error: {
                            code: "INVALID_EXTENSION_TIME",
                            message: "Extension time is invalid.",
                        },
                    });
                    return;

                case "INVALID_TRANSITION":
                    response.status(409).json({
                        error: {
                            code: "INVALID_SESSION_TRANSITION",
                            message:
                                "Only an in-progress session can be extended.",
                        },
                    });
                    return;

                case "SESSION_TIMER_CONFLICT":
                    response.status(409).json({
                        error: {
                            code: "SESSION_TIMER_CONFLICT",
                            message:
                                "Session deadline has changed.",
                        },
                    });
                    return;
                case "INVALID_COMPLETION_TIME":
                    response.status(400).json({
                        error: {
                            code: "INVALID_COMPLETION_TIME",
                            message: "Completion time is invalid.",
                        },
                    });
                    return;
            }
        } catch (error) {
            console.error(
                "Failed to synchronize routine:",
                error,
            );

            response.status(500).json({
                error: {
                    code: "INTERNAL_ERROR",
                    message: "Unable to sync routine.",
                },
            });
        }
    },
);
