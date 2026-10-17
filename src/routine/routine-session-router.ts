
import { Router } from "express";

import { Prisma } from "@prisma/client";

import { requireAuth } from "../auth/require-auth";

import {
    completeRoutineSessionSchema,
    extendRoutineSessionSchema,
    startRoutineSessionSchema,
} from "./routine-session-schema";

import {
    completeRoutineSessionForUser,
    extendRoutineSessionForUser,
    getRoutineSessionsForUser,
    RoutineSessionConflictError,
    startRoutineSessionForUser,
} from "./routine-session-service";

export const routineSessionRouter = Router();

/**
 * GET /routine-sessions
 *
 * Return only the current user's session history.
 */
routineSessionRouter.get(
    "/",
    requireAuth,
    async (request, response) => {
        try {
            const userId = request.auth!.user.id;

            const sessions =
                await getRoutineSessionsForUser(userId);

            response.status(200).json({
                sessions,
            });
        } catch (error) {
            console.error(
                "Unable to load RoutineSessions:",
                error,
            );

            response.status(500).json({
                error: {
                    code: "INTERNAL_ERROR",
                    message: "Unable to load routine sessions.",
                },
            });
        }
    },
);

/**
 * POST /routine-sessions
 *
 * Start a session for a routine owned
 * by the authenticated account.
 */
routineSessionRouter.post(
    "/",
    requireAuth,
    async (request, response) => {
        const parsed =
            startRoutineSessionSchema.safeParse(
                request.body,
            );

        if (!parsed.success) {
            response.status(400).json({
                error: {
                    code: "INVALID_ROUTINE_SESSION",
                    message: "Session data is invalid.",
                    details: parsed.error.flatten(),
                },
            });

            return;
        }

        try {
            const userId = request.auth!.user.id;

            const result =
                await startRoutineSessionForUser(
                    userId,
                    parsed.data,
                );

            if (result.kind === "NOT_FOUND") {
                response.status(404).json({
                    error: {
                        code: "ROUTINE_NOT_FOUND",
                        message: "Routine was not found.",
                    },
                });

                return;
            }

            response.status(201).json({
                session: result.session,
            });

        } catch (error) {
            if (
                error instanceof RoutineSessionConflictError
            ) {
                response.status(409).json({
                    error: {
                        code: "ROUTINE_SESSION_CONFLICT",
                        message: error.message,
                    },
                });

                return;
            }

            if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === "P2002"
            ) {
                response.status(409).json({
                    error: {
                        code: "ROUTINE_SESSION_CONFLICT",
                        message: "Session could not be created.",
                    },
                });

                return;
            }

            console.error(
                "Unable to start RoutineSession:",
                error,
            );

            response.status(500).json({
                error: {
                    code: "INTERNAL_ERROR",
                    message: "Unable to start routine session.",
                },
            });
        }
    },
);


routineSessionRouter.post(
  "/:id/complete",
  requireAuth,
  async (request, response) => {
    const sessionId = request.params.id;

    if (
      typeof sessionId !== "string" ||
      !sessionId.trim()
    ) {
      response.status(400).json({
        error: {
          code: "INVALID_SESSION_ID",
          message: "Session ID is invalid.",
        },
      });
      return;
    }

    const parsed =
      completeRoutineSessionSchema.safeParse(
        request.body,
      );

    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: "INVALID_COMPLETION",
          message: "Completion data is invalid.",
        },
      });
      return;
    }

    try {
      const result =
        await completeRoutineSessionForUser(
          request.auth!.user.id,
          sessionId,
          parsed.data,
        );

      if (result.kind === "NOT_FOUND") {
        response.status(404).json({
          error: {
            code: "SESSION_NOT_FOUND",
            message: "Session was not found.",
          },
        });
        return;
      }

      if (result.kind === "INVALID_TIME") {
        response.status(400).json({
          error: {
            code: "INVALID_COMPLETION_TIME",
            message: "Completion time is invalid.",
          },
        });
        return;
      }

      if (result.kind === "INVALID_TRANSITION") {
        response.status(409).json({
          error: {
            code: "INVALID_SESSION_TRANSITION",
            message: "Session cannot be completed.",
          },
        });
        return;
      }

      response.status(200).json({
        session: result.session,
      });
    } catch (error) {
      console.error(
        "Failed to complete RoutineSession:",
        error,
      );

      response.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "Unable to complete session.",
        },
      });
    }
  },
);


/**
 * POST /routine-sessions/:id/extend
 *
 * Extend an IN_PROGRESS session.
 */
routineSessionRouter.post(
  "/:id/extend",
  requireAuth,

  async (request, response) => {
    const sessionId = request.params.id;

    if (
      typeof sessionId !== "string" ||
      !sessionId.trim()
    ) {
      response.status(400).json({
        error: {
          code: "INVALID_SESSION_ID",
          message: "Session ID is invalid.",
        },
      });

      return;
    }

    const parsed =
      extendRoutineSessionSchema.safeParse(
        request.body,
      );

    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: "INVALID_EXTENSION",
          message: "Extension data is invalid.",
          details: parsed.error.flatten(),
        },
      });

      return;
    }

    try {
      const userId =
        request.auth!.user.id;

      const result =
        await extendRoutineSessionForUser(
          userId,
          sessionId,
          parsed.data,
        );

      switch (result.kind) {
        case "NOT_FOUND":
          response.status(404).json({
            error: {
              code: "SESSION_NOT_FOUND",
              message: "Session was not found.",
            },
          });
          return;

        case "INVALID_TIME":
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
              message: "Only an in-progress session can be extended.",
            },
          });
          return;

        case "CONFLICT":
          response.status(409).json({
            error: {
              code: "SESSION_TIMER_CONFLICT",
              message: "Session deadline has changed.",
            },
          });
          return;

        case "EXTENDED":
          response.status(200).json({
            session: result.session,
          });
          return;
      }
    } catch (error) {
      console.error(
        "Failed to extend RoutineSession:",
        error,
      );

      response.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "Unable to extend session.",
        },
      });
    }
  },
);