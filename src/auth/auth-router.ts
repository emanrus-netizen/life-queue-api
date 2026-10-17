import {
    Router
} from "express";
import {
    loginInputSchema,
    registerInputSchema,
} from "./auth-validation.js";

import { prisma } from "../db/prisma.js";
import { loginLimiter, registerLimiter } from "../middleware/rate-limit.js";
import {
    EmailAlreadyExistsError,
    InvalidCredentialsError,
    loginUser,
    registerUser,
} from "./auth-service.js";
import { requireAuth } from "./require-auth.js";


export const authRouter = Router()
authRouter.get("/me",
    requireAuth,
    (request, response) => {
        /**
         * requireAuth already verified this user.
         *
         * We do NOT perform:
         *
         * request.query.userId
         * request.body.userId
         *
         * The session is the identity authority.
         */

        if (
            !request.auth
        ) { /**
       * Type/runtime safeguard.
       *
       * In normal operation this cannot happen
       * because requireAuth runs first.
       */
            response.status(401).json({
                error: {
                    code: "UNAUTHORIZED",
                    message: "Authentication is required.",
                }
            });

            return;
        }

        response.json({
            user: request.auth.user,
        })
    }
)
authRouter.post(
    "/register",
    registerLimiter,
    async (request, response) => {
        /**
         * Never trust request.body directly.
         *
         * Zod gives us:
         *
         * - valid email
         * - normalized lowercase email
         * - password requirements
         * - cleaned displayName
         */
        const parsed = registerInputSchema.safeParse(request.body)

        if (!parsed.success) {
            response.status(
                400
            ).json({
                error: {
                    code: "INVALID_INPUT",
                    message:
                        "Registration details are invalid.",
                    issues: parsed.error.issues.map(
                        issue => ({
                            path: issue.path.join('.'),
                            message: issue.message
                        })
                    )
                }
            })
            return;

        }
        try {
            const result = await registerUser(
                parsed.data
            )
            /**
         * Notice what we DON'T return:
         *
         * passwordHash ❌
         * tokenHash    ❌
         *
         * Only safe public data plus the raw
         * session credential.
      */
            response.status(201).json({
                user: result.user,
                session: {
                    token: result.token,
                    expiresAt: result.expiresAt
                },
            })
        } catch (error) {
            if (error instanceof EmailAlreadyExistsError) {
                response.status(409).json({
                    error: {
                        code: "EMAIL_ALREADY_EXISTS",
                        message: error.message
                    }
                })

                return
            }

            /**
             * Log the error object, but NEVER log:
             *
             * request.body.password
             * raw session tokens
             */
            console.error(
                "Registration failed:",
                error,
            );


            response.status(
                500,
            ).json({
                error: {
                    code:
                        "INTERNAL_ERROR",

                    message:
                        "Unable to create account.",
                },
            });
        }
    }
)


authRouter.post(
    "/login",
    loginLimiter,
    async (request, response) => {
        const parsed = loginInputSchema.safeParse(request.body)

        if (!parsed.success) {
            response.status(400).json({
                error: {
                    code: "INVALID_INPUT",
                },
                message: "Login details are invalid",

                issues: parsed.error.issues.map(
                    issue => ({
                        path: issue.path.join("."),
                        message: issue.message
                    })
                )
            });
            return;
        }

        try {
            const result = await loginUser(parsed.data)

            response.status(200).json({
                user: result.user,
                session: {
                    token: result.token,
                    expiresAt: result.expiresAt
                },
            })
        } catch (error) {
            if (error instanceof InvalidCredentialsError) {
                response.status(401).json({
                    error: {
                        code: "INVALID_CREDENTIALS",
                        message: error.message
                    }

                });
                return;
            }

            console.log("Login Failed", error)

            response.status(500).json({
                error: {
                    code: "INTERNAL_ERROR",
                    message: "Unable to sign in."
                }
            })
        }


    }
)

authRouter.post("/logout",
    requireAuth,
    async (request, response) => {
        if (!request.auth) {
            response.status(
                401
            ).json({
                error: {
                    code: "UNAUTHORIZED",
                    message: "Authorize is required."
                }
            });

            return;
        }

        /**
         * Revoke ONLY the session used for this
         * request.
         *
         * Other devices stay logged in.
         */

        await prisma.session.delete({
            where: {
                id: request.auth.sessionId
            }
        });

        response.status(204).send()
    }
)