
import { rateLimit } from "express-rate-limit";

/**
 * LOGIN RATE LIMIT
 *
 * Maximum 5 attempts per 15 minutes
 * from the same client IP.
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,

  standardHeaders: "draft-7",
  legacyHeaders: false,

  message: {
    error: {
      code: "RATE_LIMITED",
      message:
        "Too many login attempts. Please try again later.",
    },
  },
});

/**
 * REGISTRATION RATE LIMIT
 *
 * Maximum 3 registration attempts
 * per hour from the same client IP.
 */
export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,

  standardHeaders: "draft-7",
  legacyHeaders: false,

  message: {
    error: {
      code: "RATE_LIMITED",
      message:
        "Too many registration attempts. Please try again later.",
    },
  },
});
