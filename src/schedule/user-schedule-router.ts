
import { Router } from "express";

import { requireAuth } from "../auth/require-auth";

import {
    getUserScheduleForUser,
    putUserScheduleForUser,
} from "./user-schedule-service";

import {
    putUserScheduleSchema,
} from "./user-schedule-schema";

export const userScheduleRouter = Router();

/**
 * GET /user-schedule
 *
 * Return the authenticated user's saved
 * daily Rhythm settings, or null if absent.
 */
userScheduleRouter.get(
  "/",
  requireAuth,
  async (request, response) => {
    try {
      const userId = request.auth!.user.id;

      const schedule =
        await getUserScheduleForUser(userId);

      response.status(200).json({ schedule });
    } catch (error) {
      console.error("Unable to load user schedule:", error);

      response.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "Unable to load schedule.",
        },
      });
    }
  },
);

/**
 * PUT /user-schedule
 *
 * userId is never accepted from request.body.
 * requireAuth determines which account owns
 * this write.
 */
userScheduleRouter.put(
  "/",
  requireAuth,
  async (request, response) => {
    const parsed =
      putUserScheduleSchema.safeParse(request.body);

    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: "INVALID_USER_SCHEDULE",
          message: "Schedule data is invalid.",
          details: parsed.error.flatten(),
        },
      });
      return;
    }

    try {
      const userId = request.auth!.user.id;

      const result = await putUserScheduleForUser(
        userId,
        parsed.data,
      );

      switch (result.kind) {
        case "OK":
          response.status(200).json(result.body);
          return;

        case "OPERATION_ID_REUSED":
          response.status(409).json({
            error: {
              code: "OPERATION_ID_REUSED",
              message:
                "This operation ID was used with different data.",
            },
          });
          return;

        case "VERSION_CONFLICT":
          response.status(409).json({
            error: {
              code: "SCHEDULE_VERSION_CONFLICT",
              message:
                "The schedule changed since this version was loaded.",
            },
          });
          return;
      }
    } catch (error) {
      console.error("Unable to save user schedule:", error);

      response.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "Unable to save schedule.",
        },
      });
    }
  },
);
