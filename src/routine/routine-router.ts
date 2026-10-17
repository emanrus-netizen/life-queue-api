
import { Router } from "express";

import { Prisma } from "@prisma/client";

import { requireAuth } from "../auth/require-auth";

import {
    createRoutineSchema,
    updateRoutineSchema,
} from "./routine-schema";

import {
    createRoutineForUser,
    getRoutinesForUser,
    InvalidRoutineDateError,
    updateRoutineForUser,
} from "./routine-service";

export const routineRouter = Router();

/**
 * GET /routines
 *
 * Returns only the authenticated user's routines.
 */
routineRouter.get(
  "/",
  requireAuth,
  async (request, response) => {
    try {
      /**
       * requireAuth has already verified the
       * bearer token and attached the user.
       */
      const userId = request.auth!.user.id;

      const routines =
        await getRoutinesForUser(userId);

      response.status(200).json({
        routines,
      });
    } catch (error) {
      console.error(
        "Failed to load routines:",
        error,
      );

      response.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "Unable to load routines.",
        },
      });
    }
  },
);

/**
 * POST /routines
 *
 * Creates a routine using a client-generated ID.
 */
routineRouter.post(
  "/",
  requireAuth,
  async (request, response) => {
    const parsed =
      createRoutineSchema.safeParse(request.body);

    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: "INVALID_ROUTINE",
          message: "Routine data is invalid.",
          details: parsed.error.flatten(),
        },
      });

      return;
    }

    try {
      const userId = request.auth!.user.id;

      const routine =
        await createRoutineForUser(
          userId,
          parsed.data,
        );

      response.status(201).json({
        routine,
      });
    } catch (error) {
      if (
        error instanceof InvalidRoutineDateError
      ) {
        response.status(400).json({
          error: {
            code: "INVALID_ROUTINE_DATE",
            message: error.message,
          },
        });

        return;
      }

      /**
       * A duplicated client-generated ID
       * must not overwrite another record.
       */
      if (
        error instanceof
          Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        response.status(409).json({
          error: {
            code: "ROUTINE_CONFLICT",
            message: "Routine ID already exists.",
          },
        });

        return;
      }

      console.error(
        "Failed to create routine:",
        error,
      );

      response.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "Unable to create routine.",
        },
      });
    }
  },
);



/**
 * PATCH /routines/:id
 *
 * Update only a routine owned by the
 * authenticated account.
 */
routineRouter.patch(
  "/:id",
  requireAuth,

  async (request, response) => {
    const routineId = request.params.id;

    /**
     * Express route parameters are untrusted.
     * Validate their runtime type.
     */
    if (
      typeof routineId !== "string" ||
      !routineId.trim()
    ) {
      response.status(400).json({
        error: {
          code: "INVALID_ROUTINE_ID",
          message: "Routine ID is invalid.",
        },
      });

      return;
    }

    /**
     * Validate allowed editable fields.
     *
     * A client cannot modify userId,
     * createdAt, or other protected fields.
     */
    const parsed =
      updateRoutineSchema.safeParse(
        request.body,
      );

    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: "INVALID_ROUTINE_UPDATE",
          message: "Routine update is invalid.",
          details: parsed.error.flatten(),
        },
      });

      return;
    }

    try {
      const userId =
        request.auth!.user.id;

      const routine =
        await updateRoutineForUser(
          userId,
          routineId,
          parsed.data,
        );

      if (!routine) {
        /**
         * Same response whether the routine
         * does not exist or belongs to
         * another user.
         */
        response.status(404).json({
          error: {
            code: "ROUTINE_NOT_FOUND",
            message: "Routine was not found.",
          },
        });

        return;
      }

      response.status(200).json({
        routine,
      });

    } catch (error) {
      console.error(
        "Failed to update routine:",
        error,
      );

      response.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "Unable to update routine.",
        },
      });
    }
  },
);
